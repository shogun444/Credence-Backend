import { describe, it, expect, beforeEach, vi } from 'vitest'
import express, { type Express } from 'express'
import request from 'supertest'
import { createAttestationRouter } from '../../src/routes/attestations.js'
import { errorHandler } from '../../src/middleware/errorHandler.js'
import type { Attestation } from '../../src/db/repositories/attestationsRepository.js'
import { setTenantId } from '../../src/utils/tenantContext.js'

const SUBJECT = '0x1111111111111111111111111111111111111111'
const ATTESTER = '0x2222222222222222222222222222222222222222'
const MIXED_SUBJECT = '0x111111111111111111111111111111111111AaAa'

const makeAttestation = (id: number, subjectAddress = SUBJECT): Attestation => ({
  id,
  bondId: 10,
  attesterAddress: ATTESTER,
  subjectAddress,
  score: 90,
  note: JSON.stringify({ key: 'kyc', value: `verified-${id}` }),
  createdAt: new Date(`2025-01-0${id}T00:00:00.000Z`),
})

describe('attestation routes', () => {
  let app: Express
  let cacheService: {
    getAttestationsBySubjectPaginated: ReturnType<typeof vi.fn>
    invalidateForAttestation: ReturnType<typeof vi.fn>
  }
  let transactionManager: {
    withTransaction: ReturnType<typeof vi.fn>
  }
  let outbox: {
    emit: ReturnType<typeof vi.fn>
  }

  beforeEach(() => {
    // Set tenant context for tests
    setTenantId('test-tenant')
    
    cacheService = {
      getAttestationsBySubjectPaginated: vi.fn(),
      invalidateForAttestation: vi.fn(),
    }
    outbox = {
      emit: vi.fn(),
    }
    transactionManager = {
      withTransaction: vi.fn(async (fn) => fn({ query: vi.fn(), release: vi.fn() })),
    }

    app = express()
    app.use(express.json())
    app.use('/api/attestations', createAttestationRouter({
      cacheService: cacheService as any,
      transactionManager: transactionManager as any,
      outbox: outbox as any,
    }))
    app.use(errorHandler)
  })

  afterEach(() => {
    // Clean up tenant context
    setTenantId(null)
  })

  describe('GET /api/attestations/:address', () => {
    it('returns a repository-backed cursor page with a next cursor when more remain', async () => {
      cacheService.getAttestationsBySubjectPaginated.mockResolvedValue({
        attestations: [makeAttestation(1), makeAttestation(2)],
        hasMore: true,
      })

      const res = await request(app)
        .get(`/api/attestations/${SUBJECT}?limit=2`)
        .expect(200)

      expect(cacheService.getAttestationsBySubjectPaginated).toHaveBeenCalledWith(SUBJECT, {
        limit: 2,
        cursor: undefined,
      })
      expect(res.body).toMatchObject({
        address: SUBJECT,
        page: {
          limit: 2,
          hasMore: true,
        },
      })
      expect(res.body.data).toHaveLength(2)
      expect(res.body.data[0].createdAt).toBe('2025-01-01T00:00:00.000Z')
      // A next cursor is emitted because hasMore is true.
      expect(typeof res.body.page.nextCursor).toBe('string')
    })

    it('returns an empty page with no next cursor when there are no more results', async () => {
      cacheService.getAttestationsBySubjectPaginated.mockResolvedValue({
        attestations: [],
        hasMore: false,
      })

      const res = await request(app)
        .get(`/api/attestations/${SUBJECT}?limit=2`)
        .expect(200)

      expect(res.body.data).toEqual([])
      expect(res.body.page.hasMore).toBe(false)
      expect(res.body.page.nextCursor).toBeNull()
    })

    it('normalizes Ethereum addresses before querying cache', async () => {
      cacheService.getAttestationsBySubjectPaginated.mockResolvedValue({
        attestations: [],
        hasMore: false,
      })

      await request(app)
        .get(`/api/attestations/${MIXED_SUBJECT}`)
        .expect(200)

      expect(cacheService.getAttestationsBySubjectPaginated).toHaveBeenCalledWith(
        MIXED_SUBJECT.toLowerCase(),
        { limit: 20, cursor: undefined },
      )
    })

    it('rejects invalid pagination', async () => {
      const res = await request(app)
        .get(`/api/attestations/${SUBJECT}?limit=999`)
        .expect(400)

      expect(res.body.error).toBe('Validation failed')
      expect(cacheService.getAttestationsBySubjectPaginated).not.toHaveBeenCalled()
    })
  })

  describe('POST /api/attestations', () => {
  it('persists an attestation, emits an outbox event, and invalidates cache', async () => {
    const created = makeAttestation(7)
    transactionManager.withTransaction.mockImplementationOnce(async (fn) => {
      const client = {
        query: vi.fn().mockResolvedValue({ rows: [{
          id: created.id,
          bond_id: created.bondId,
          attester_address: created.attesterAddress,
          subject_address: created.subjectAddress,
          score: created.score,
          note: created.note,
          created_at: created.createdAt,
        }] }),
      }
      return fn(client)
    })

    const res = await request(app)
      .post('/api/attestations')
      .set('x-tenant-id', 'test-tenant')
      .send({
        bondId: 10,
        attesterAddress: ATTESTER.toUpperCase().replace('X', 'x'),
        subject: SUBJECT,
        key: 'kyc',
        value: 'verified',
        score: 90,
      })
      .expect(201)

    expect(res.body).toMatchObject({
      id: 7,
      bondId: 10,
      attesterAddress: ATTESTER,
      subjectAddress: SUBJECT,
      score: 90,
    })
    expect(outbox.emit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      aggregateType: 'attestation',
      aggregateId: '7',
      eventType: 'attestation.created',
    }))
    expect(cacheService.invalidateForAttestation).toHaveBeenCalledWith(expect.objectContaining({
      id: 7,
      subjectAddress: SUBJECT,
    }))
  })

    it('rejects duplicate attestations', async () => {
      transactionManager.withTransaction.mockRejectedValueOnce({ code: '23505' })

      const res = await request(app)
        .post('/api/attestations')
        .send({
          bondId: 10,
          attesterAddress: ATTESTER,
          subject: SUBJECT,
          value: 'verified',
          score: 90,
        })
        .expect(409)

      expect(res.body.error).toBe('Duplicate attestation')
      expect(cacheService.invalidateForAttestation).not.toHaveBeenCalled()
    })

    it('rejects oversized values', async () => {
      await request(app)
        .post('/api/attestations')
        .send({
          bondId: 10,
          attesterAddress: ATTESTER,
          subject: SUBJECT,
          value: 'x'.repeat(2049),
          score: 90,
        })
        .expect(400)

      expect(transactionManager.withTransaction).not.toHaveBeenCalled()
    })

    it('rejects oversized keys', async () => {
      await request(app)
        .post('/api/attestations')
        .send({
          bondId: 10,
          attesterAddress: ATTESTER,
          subject: SUBJECT,
          key: 'k'.repeat(129),
          value: 'verified',
          score: 90,
        })
        .expect(400)

      expect(transactionManager.withTransaction).not.toHaveBeenCalled()
    })
  })
})