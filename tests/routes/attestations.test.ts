import { describe, it, expect, beforeEach, vi } from 'vitest'
import express, { type Express } from 'express'
import request from 'supertest'
import { createAttestationRouter } from '../../src/routes/attestations.js'
import { errorHandler } from '../../src/middleware/errorHandler.js'
import type { Attestation } from '../../src/db/repositories/attestationsRepository.js'

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
    getAttestationsBySubjectPage: ReturnType<typeof vi.fn>
    invalidateForAttestation: ReturnType<typeof vi.fn>
  }
  let transactionManager: {
    withTransaction: ReturnType<typeof vi.fn>
  }
  let outbox: {
    emit: ReturnType<typeof vi.fn>
  }

  beforeEach(() => {
    cacheService = {
      getAttestationsBySubjectPage: vi.fn(),
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

  describe('GET /api/attestations/:address', () => {
    it('returns a repository-backed page with accurate totals', async () => {
      cacheService.getAttestationsBySubjectPage.mockResolvedValue({
        attestations: [makeAttestation(1), makeAttestation(2)],
        total: 5,
      })

      const res = await request(app)
        .get(`/api/attestations/${SUBJECT}?page=2&limit=2`)
        .expect(200)

      expect(cacheService.getAttestationsBySubjectPage).toHaveBeenCalledWith(SUBJECT, {
        offset: 2,
        limit: 2,
      })
      expect(res.body).toMatchObject({
        address: SUBJECT,
        page: 2,
        limit: 2,
        offset: 2,
        total: 5,
        hasNext: true,
      })
      expect(res.body.attestations).toHaveLength(2)
      expect(res.body.attestations[0].createdAt).toBe('2025-01-01T00:00:00.000Z')
    })

    it('returns an empty page beyond the last page while preserving total', async () => {
      cacheService.getAttestationsBySubjectPage.mockResolvedValue({
        attestations: [],
        total: 3,
      })

      const res = await request(app)
        .get(`/api/attestations/${SUBJECT}?page=100&limit=2`)
        .expect(200)

      expect(res.body.attestations).toEqual([])
      expect(res.body.total).toBe(3)
      expect(res.body.hasNext).toBe(false)
    })

    it('normalizes Ethereum addresses before querying cache', async () => {
      cacheService.getAttestationsBySubjectPage.mockResolvedValue({
        attestations: [],
        total: 0,
      })

      await request(app)
        .get(`/api/attestations/${MIXED_SUBJECT}`)
        .expect(200)

      expect(cacheService.getAttestationsBySubjectPage).toHaveBeenCalledWith(
        MIXED_SUBJECT.toLowerCase(),
        { offset: 0, limit: 20 },
      )
    })

    it('rejects invalid pagination', async () => {
      const res = await request(app)
        .get(`/api/attestations/${SUBJECT}?limit=999`)
        .expect(400)

      expect(res.body.error).toBe('Validation failed')
      expect(cacheService.getAttestationsBySubjectPage).not.toHaveBeenCalled()
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
