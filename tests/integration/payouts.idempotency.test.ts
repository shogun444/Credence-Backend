/**
 * Integration tests for POST /api/payouts idempotency key enforcement.
 *
 * Covers:
 *   1. First request – creates payout and returns 201.
 *   2. Exact replay – same key + same payload returns the stored 201 response.
 *   3. Payload mismatch – same key + different payload returns 400.
 *   4. Key expiry – expired key is treated as a new request.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgres://... node --test tests/integration/payouts.idempotency.test.ts
 * or let the test harness spin up a Testcontainer automatically.
 */

import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'
import express from 'express'
import type { Express } from 'express'
import { Pool } from 'pg'

import { IdempotencyRepository } from '../../src/db/repositories/idempotencyRepository.js'
import { PayoutsRepository } from '../../src/db/repositories/payoutsRepository.js'
import { idempotencyMiddleware } from '../../src/middleware/idempotency.js'
import { validate } from '../../src/middleware/validate.js'
import { createTestDatabase, type TestDatabase } from './testDatabase.js'
import { z } from 'zod'

// ---------------------------------------------------------------------------
// Schema (mirrors src/routes/payouts.ts)
// ---------------------------------------------------------------------------

const createPayoutBodySchema = z.object({
  recipient: z.string().min(1),
  amount: z.string().regex(/^\d+(\.\d+)?$/),
  currency: z.string().length(3).toUpperCase().optional(),
  metadata: z.record(z.unknown()).optional(),
})

// ---------------------------------------------------------------------------
// DB setup helpers
// ---------------------------------------------------------------------------

async function createTables(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS idempotency_keys (
      key TEXT PRIMARY KEY,
      request_hash TEXT NOT NULL,
      response_code INTEGER NOT NULL,
      response_body JSONB NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS payouts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      recipient TEXT NOT NULL,
      amount NUMERIC(36, 18) NOT NULL CHECK (amount > 0),
      currency TEXT NOT NULL DEFAULT 'USD',
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
}

async function truncateTables(pool: Pool): Promise<void> {
  await pool.query('TRUNCATE TABLE idempotency_keys, payouts')
}

// ---------------------------------------------------------------------------
// Minimal Express app factory
// ---------------------------------------------------------------------------

function buildApp(pool: Pool): Express {
  const app = express()
  app.use(express.json())

  const payoutsRepo = new PayoutsRepository(pool)
  const idempotencyRepo = new IdempotencyRepository(pool)

  app.post(
    '/api/payouts',
    idempotencyMiddleware(idempotencyRepo),
    validate({ body: createPayoutBodySchema }),
    async (req, res, next) => {
      try {
        const body = req.validated!.body as z.infer<typeof createPayoutBodySchema>
        const payout = await payoutsRepo.create(body)
        res.status(201).json({ success: true, data: payout })
      } catch (err) {
        next(err)
      }
    },
  )

  return app
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

async function post(
  app: Express,
  path: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address()
      if (!addr || typeof addr === 'string') {
        server.close()
        reject(new Error('Could not get server address'))
        return
      }

      const url = `http://127.0.0.1:${addr.port}${path}`
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
      })
        .then(async (res) => {
          const json = await res.json()
          server.close()
          resolve({ status: res.status, body: json as Record<string, unknown> })
        })
        .catch((err) => {
          server.close()
          reject(err)
        })
    })
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /api/payouts – idempotency', () => {
  let database: TestDatabase
  let pool: Pool
  let app: Express

  before(async () => {
    database = await createTestDatabase()
    pool = database.pool
    await createTables(pool)
  })

  beforeEach(async () => {
    await truncateTables(pool)
    app = buildApp(pool)
  })

  after(async () => {
    await database.close()
  })

  // -------------------------------------------------------------------------

  it('first request – creates payout and returns 201', async () => {
    const payload = { recipient: 'alice@example.com', amount: '100.00' }
    const { status, body } = await post(
      app,
      '/api/payouts',
      { 'idempotency-key': 'key-first-request' },
      payload,
    )

    assert.equal(status, 201)
    assert.equal((body as any).success, true)
    assert.ok((body as any).data?.id, 'response should include payout id')
    assert.equal((body as any).data?.recipient, 'alice@example.com')
  })

  it('exact replay – same key + same payload returns stored 201 response', async () => {
    const payload = { recipient: 'bob@example.com', amount: '50.00' }
    const headers = { 'idempotency-key': 'key-replay' }

    const first = await post(app, '/api/payouts', headers, payload)
    assert.equal(first.status, 201)

    const second = await post(app, '/api/payouts', headers, payload)
    assert.equal(second.status, 201)

    // Replayed response must be identical to the first
    assert.deepEqual(second.body, first.body)

    // Only one payout row should exist
    const rows = await pool.query('SELECT COUNT(*) AS cnt FROM payouts')
    assert.equal(Number(rows.rows[0].cnt), 1)
  })

  it('payload mismatch – same key + different payload returns 400', async () => {
    const headers = { 'idempotency-key': 'key-mismatch' }

    await post(app, '/api/payouts', headers, { recipient: 'carol@example.com', amount: '10.00' })

    const { status, body } = await post(
      app,
      '/api/payouts',
      headers,
      { recipient: 'carol@example.com', amount: '99.00' }, // different amount
    )

    assert.equal(status, 400)
    assert.equal((body as any).error, 'IdempotencyParameterMismatch')
  })

  it('key expiry – expired key is treated as a new request', async () => {
    const headers = { 'idempotency-key': 'key-expiry' }
    const payload = { recipient: 'dave@example.com', amount: '25.00' }

    const first = await post(app, '/api/payouts', headers, payload)
    assert.equal(first.status, 201)

    // Manually expire the key
    await pool.query(
      `UPDATE idempotency_keys
       SET expires_at = NOW() - INTERVAL '1 second'
       WHERE key = $1`,
      ['key-expiry'],
    )

    const second = await post(app, '/api/payouts', headers, payload)
    assert.equal(second.status, 201)

    // A new payout should have been created (two rows total)
    const rows = await pool.query('SELECT COUNT(*) AS cnt FROM payouts')
    assert.equal(Number(rows.rows[0].cnt), 2)
  })
})
