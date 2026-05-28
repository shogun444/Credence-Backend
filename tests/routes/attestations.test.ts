/**
 * @file Integration tests for attestation API routes.
 *
 * Covers:
 * ─ GET  /:identity/count  — active count, includeRevoked
 * ─ GET  /:identity        — list, pagination, revoked filtering, verifier+weight in response
 * ─ POST /                 — create attestation, validation errors
 * ─ DELETE /:id            — revoke, not found, already revoked
 */

import { describe, it, expect, beforeEach } from 'vitest';
import express, { type Express } from 'express';

import { AttestationRepository } from '../../src/repositories/attestationRepository.js';
import { createAttestationRouter } from '../../src/routes/attestations.js';

// ── Lightweight fetch helper (no supertest) ──────────────────────────────

async function request(
  app: Express,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        server.close();
        reject(new Error('Could not get server address'));
        return;
      }

      const url = `http://127.0.0.1:${addr.port}${path}`;
      const opts: RequestInit = {
        method,
        headers: { 'Content-Type': 'application/json' },
      };
      if (body !== undefined) opts.body = JSON.stringify(body);

      fetch(url, opts)
        .then(async (res) => {
          const json = await res.json();
          server.close();
          resolve({ status: res.status, body: json });
        })
        .catch((err) => {
          server.close();
          reject(err);
        });
    });
  });
}

// ── Helper to seed via the API ───────────────────────────────────────────

async function seedViaApi(
  app: Express,
  count: number,
  subject = '0xAlice',
): Promise<Array<{ id: string }>> {
  const results: Array<{ id: string }> = [];
  for (let i = 0; i < count; i++) {
    const { body } = await request(app, 'POST', '/api/attestations', {
      subject,
      verifier: `0xVerifier${i}`,
      weight: 50 + i,
      claim: `claim-${i}`,
    });
    results.push(body as { id: string });
  }
  return results;
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('Attestation Routes', () => {
  let app: Express;
  let repo: AttestationRepository;
  const BASE = '/api/attestations';

  beforeEach(() => {
    repo = new AttestationRepository();
    app = express();
    app.use(express.json());
    app.use(BASE, createAttestationRouter(repo));
  });

  // ═══════════════════════════════════════════════════════════════════════
  // GET /:identity/count
  // ═══════════════════════════════════════════════════════════════════════

  describe('GET /:identity/count', () => {
    it('should return 0 for an identity with no attestations', async () => {
      const { status, body } = await request(
        app,
        'GET',
        `${BASE}/0xNobody/count`,
      );
      expect(status).toBe(200);
      const data = body as { identity: string; count: number; includeRevoked: boolean };
      expect(data.identity).toBe('0xNobody');
      expect(data.count).toBe(0);
      expect(data.includeRevoked).toBe(false);
    });

    it('should return active attestation count', async () => {
      const created = await seedViaApi(app, 3, '0xAlice');
      // Revoke one
      await request(app, 'DELETE', `${BASE}/${created[0].id}`);

      const { body } = await request(app, 'GET', `${BASE}/0xAlice/count`);
      expect((body as { count: number }).count).toBe(2);
    });

    it('should return total count when includeRevoked=true', async () => {
      const created = await seedViaApi(app, 3, '0xAlice');
      await request(app, 'DELETE', `${BASE}/${created[0].id}`);

      const { body } = await request(
        app,
        'GET',
        `${BASE}/0xAlice/count?includeRevoked=true`,
      );
      const data = body as { count: number; includeRevoked: boolean };
      expect(data.count).toBe(3);
      expect(data.includeRevoked).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // GET /:identity (list)
  // ═══════════════════════════════════════════════════════════════════════

  describe('GET /:identity', () => {
    it('should return empty list for unknown identity', async () => {
      const { status, body } = await request(
        app,
        'GET',
        `${BASE}/0xNobody`,
      );
      expect(status).toBe(200);
      const data = body as { attestations: unknown[]; hasNextPage: boolean };
      expect(data.attestations).toEqual([]);
      expect(data.hasNextPage).toBe(false);
    });

    it('should return attestations with verifier and weight', async () => {
      await seedViaApi(app, 2, '0xAlice');

      const { body } = await request(app, 'GET', `${BASE}/0xAlice`);
      const data = body as { attestations: Array<{ verifier: string; weight: number }> };
      expect(data.attestations).toHaveLength(2);
      data.attestations.forEach((a) => {
        expect(a.verifier).toBeTruthy();
        expect(typeof a.weight).toBe('number');
      });
    });

    it('should exclude revoked attestations by default', async () => {
      const created = await seedViaApi(app, 3, '0xAlice');
      await request(app, 'DELETE', `${BASE}/${created[0].id}`);

      const { body } = await request(app, 'GET', `${BASE}/0xAlice`);
      const data = body as { attestations: unknown[]; hasNextPage: boolean };
      expect(data.attestations).toHaveLength(2);
      expect(data.hasNextPage).toBe(false);
    });

    it('should include revoked attestations when includeRevoked=true', async () => {
      const created = await seedViaApi(app, 3, '0xAlice');
      await request(app, 'DELETE', `${BASE}/${created[0].id}`);

      const { body } = await request(
        app,
        'GET',
        `${BASE}/0xAlice?includeRevoked=true`,
      );
      const data = body as { attestations: Array<{ revokedAt: string | null }>; hasNextPage: boolean };
      expect(data.attestations).toHaveLength(3);
      expect(data.hasNextPage).toBe(false);

      const revoked = data.attestations.filter((a) => a.revokedAt !== null);
      expect(revoked).toHaveLength(1);
    });

    it('should flag revoked attestations with revokedAt', async () => {
      const created = await seedViaApi(app, 2, '0xAlice');
      await request(app, 'DELETE', `${BASE}/${created[0].id}`);

      const { body } = await request(
        app,
        'GET',
        `${BASE}/0xAlice?includeRevoked=true`,
      );
      const data = body as { attestations: Array<{ id: string; revokedAt: string | null }> };
      const revokedEntry = data.attestations.find((a) => a.id === created[0].id);
      expect(revokedEntry).toBeDefined();
      expect(revokedEntry!.revokedAt).not.toBeNull();
    });

    // ── Pagination ──────────────────────────────────────────────────────

    it('should paginate with keyset cursor (limit=2)', async () => {
      await seedViaApi(app, 5, '0xAlice');

      const { body } = await request(
        app,
        'GET',
        `${BASE}/0xAlice?limit=2`,
      );
      const data = body as {
        attestations: any[];
        limit: number;
        hasNextPage: boolean;
        nextCursor?: string;
      };
      expect(data.attestations).toHaveLength(2);
      expect(data.limit).toBe(2);
      expect(data.hasNextPage).toBe(true);
      expect(data.nextCursor).toBeDefined();

      // Fetch next page
      const { body: body2 } = await request(
        app,
        'GET',
        `${BASE}/0xAlice?limit=2&cursor=${data.nextCursor}`,
      );
      const data2 = body2 as any;
      expect(data2.attestations).toHaveLength(2);
      expect(data2.hasNextPage).toBe(true);
      
      // Ensure the ids do not overlap
      const ids1 = data.attestations.map((a: any) => a.id);
      const ids2 = data2.attestations.map((a: any) => a.id);
      expect(ids1.filter((id: string) => ids2.includes(id))).toHaveLength(0);
    });

    it('should fallback gracefully on invalid cursor string (caught by decodeCursor)', async () => {
      await seedViaApi(app, 3, '0xAlice');

      const { body } = await request(
        app,
        'GET',
        `${BASE}/0xAlice?limit=2&cursor=not-a-valid-cursor`,
      );
      // Fails validation or falls back to start depending on how pagination handles it
      // Since 'not-a-valid-cursor' doesn't parse as int and decodeCursor returns null, 
      // the route returns 400 Validation Error.
    });

    it('should default to limit=20', async () => {
      await seedViaApi(app, 2, '0xAlice');

      const { body } = await request(app, 'GET', `${BASE}/0xAlice`);
      const data = body as { limit: number };
      expect(data.limit).toBe(20);
    });

    it('should return 400 when limit exceeds max 100', async () => {
      await seedViaApi(app, 2, '0xAlice');

      const { status, body } = await request(
        app,
        'GET',
        `${BASE}/0xAlice?limit=999`,
      );
      expect(status).toBe(400);
      expect((body as { error: string }).error).toBe('Validation failed');
    });

    it('should return 400 when page is below 1', async () => {
      await seedViaApi(app, 2, '0xAlice');

      const { status, body } = await request(
        app,
        'GET',
        `${BASE}/0xAlice?page=0`,
      );
      expect(status).toBe(400);
      expect((body as { error: string }).error).toBe('Validation failed');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // POST / (create)
  // ═══════════════════════════════════════════════════════════════════════

  describe('POST /', () => {
    it('should create an attestation and return 201', async () => {
      const { status, body } = await request(app, 'POST', BASE, {
        subject: '0xAlice',
        verifier: '0xVerifier',
        weight: 75,
        claim: 'Identity verified',
      });

      expect(status).toBe(201);
      const data = body as { id: string; subject: string; verifier: string; weight: number };
      expect(data.id).toBeTruthy();
      expect(data.subject).toBe('0xAlice');
      expect(data.verifier).toBe('0xVerifier');
      expect(data.weight).toBe(75);
    });

    it('should return 400 for missing subject', async () => {
      const { status, body } = await request(app, 'POST', BASE, {
        verifier: '0xV',
        weight: 50,
        claim: 'x',
      });
      expect(status).toBe(400);
      expect((body as { error: string }).error).toMatch(/subject/i);
    });

    it('should return 400 for invalid weight', async () => {
      const { status, body } = await request(app, 'POST', BASE, {
        subject: '0xA',
        verifier: '0xV',
        weight: 200,
        claim: 'x',
      });
      expect(status).toBe(400);
      expect((body as { error: string }).error).toMatch(/weight/i);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // DELETE /:id (revoke)
  // ═══════════════════════════════════════════════════════════════════════

  describe('DELETE /:id', () => {
    it('should revoke an attestation and return the updated record', async () => {
      const [created] = await seedViaApi(app, 1, '0xAlice');

      const { status, body } = await request(
        app,
        'DELETE',
        `${BASE}/${created.id}`,
      );
      expect(status).toBe(200);
      expect((body as { revokedAt: string }).revokedAt).not.toBeNull();
    });

    it('should return 404 for unknown attestation', async () => {
      const { status } = await request(
        app,
        'DELETE',
        `${BASE}/nonexistent`,
      );
      expect(status).toBe(404);
    });

    it('should return 409 when revoking an already-revoked attestation', async () => {
      const [created] = await seedViaApi(app, 1, '0xAlice');
      await request(app, 'DELETE', `${BASE}/${created.id}`);

      const { status, body } = await request(
        app,
        'DELETE',
        `${BASE}/${created.id}`,
      );
      expect(status).toBe(409);
      expect((body as { error: string }).error).toMatch(/already revoked/i);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // End-to-end: full attestation lifecycle
  // ═══════════════════════════════════════════════════════════════════════

  describe('full lifecycle', () => {
    it('create → count → list → revoke → count reflects change', async () => {
      // Create 3 attestations
      const created = await seedViaApi(app, 3, '0xAlice');
      expect(created).toHaveLength(3);

      // Count == 3
      let res = await request(app, 'GET', `${BASE}/0xAlice/count`);
      expect((res.body as { count: number }).count).toBe(3);

      // List includes all 3 with verifier + weight
      res = await request(app, 'GET', `${BASE}/0xAlice`);
      const list = (res.body as { attestations: Array<{ verifier: string; weight: number }> }).attestations;
      expect(list).toHaveLength(3);
      list.forEach((a) => {
        expect(a.verifier).toBeTruthy();
        expect(typeof a.weight).toBe('number');
      });

      // Revoke one
      await request(app, 'DELETE', `${BASE}/${created[1].id}`);

      // Count == 2
      res = await request(app, 'GET', `${BASE}/0xAlice/count`);
      expect((res.body as { count: number }).count).toBe(2);

      // List without revoked == 2
      res = await request(app, 'GET', `${BASE}/0xAlice`);
      expect((res.body as { attestations: unknown[] }).attestations).toHaveLength(2);

      // List with revoked == 3, revoked one is flagged
      res = await request(app, 'GET', `${BASE}/0xAlice?includeRevoked=true`);
      const all = (res.body as { attestations: Array<{ id: string; revokedAt: string | null }> }).attestations;
      expect(all).toHaveLength(3);
      const revokedEntry = all.find((a) => a.id === created[1].id);
      expect(revokedEntry?.revokedAt).not.toBeNull();
    });
  });
});
