import { Router, type Request, type Response, type NextFunction } from 'express'
import type { PoolClient } from 'pg'
import {
  buildPaginationMeta,
  parsePaginationParams,
  PaginationValidationError,
} from '../lib/pagination.js'
import { ValidationError, ErrorCode, NotFoundError } from '../lib/errors.js'
import { validate } from '../middleware/validate.js'
import {
  attestationsPathParamsSchema,
  createAttestationBodySchema,
} from '../schemas/index.js'
import {
  AttestationsRepository,
  type Attestation,
  type CreateAttestationInput,
} from '../db/repositories/attestationsRepository.js'
import { pool } from '../db/pool.js'
import { TransactionManager } from '../db/transaction.js'
import { outboxEmitter, type OutboxEventEmitter } from '../db/outbox/index.js'
import { AttestationCacheService } from '../services/attestationCacheService.js'
import type { Queryable } from '../db/repositories/queryable.js'

interface AttestationRouterDeps {
  db?: Queryable
  repository?: AttestationsRepository
  cacheService?: AttestationCacheService
  transactionManager?: Pick<TransactionManager, 'withTransaction'>
  outbox?: Pick<OutboxEventEmitter, 'emit'>
}

type CreateAttestationBody = {
  bondId?: number
  attesterAddress?: string
  subject: string
  value: string
  key?: string
  score?: number
}

type LegacyAttestationRepository = {
  countBySubject: (subject: string, includeRevoked?: boolean) => number
  findBySubject: (
    subject: string,
    options?: { includeRevoked?: boolean; offset?: number; limit?: number }
  ) => { attestations: unknown[]; total: number }
  create: (input: { subject: string; verifier: string; weight: number; claim: string }) => unknown
  revoke: (id: string) => unknown | undefined
}

const normalizeAddress = (address: string): string =>
  address.startsWith('0x') ? address.toLowerCase() : address

const serializeAttestation = (attestation: Attestation) => ({
  id: attestation.id,
  bondId: attestation.bondId,
  attesterAddress: attestation.attesterAddress,
  subjectAddress: attestation.subjectAddress,
  score: attestation.score,
  note: attestation.note,
  createdAt: attestation.createdAt.toISOString(),
})

const buildNote = (body: CreateAttestationBody): string =>
  JSON.stringify({
    key: body.key ?? null,
    value: body.value,
  })

const isDuplicateAttestationError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  (error as { code?: string }).code === '23505'

const isLegacyRepository = (value: unknown): value is LegacyAttestationRepository =>
  typeof value === 'object' &&
  value !== null &&
  'countBySubject' in value &&
  'findBySubject' in value

function createLegacyAttestationRouter(repo: LegacyAttestationRepository): Router {
  const router = Router()

  router.get('/:identity/count', (req: Request, res: Response): void => {
    const includeRevoked = req.query.includeRevoked === 'true'
    res.json({
      identity: req.params.identity,
      count: repo.countBySubject(req.params.identity, includeRevoked),
      includeRevoked,
    })
  })

  router.get('/:identity', (req: Request, res: Response, next: NextFunction): void => {
    try {
      const { page, limit, offset } = parsePaginationParams(req.query as Record<string, unknown>)
      const result = repo.findBySubject(req.params.identity, {
        includeRevoked: req.query.includeRevoked === 'true',
        offset,
        limit,
      })

      res.json({
        identity: req.params.identity,
        attestations: result.attestations,
        ...buildPaginationMeta(result.total, page, limit),
      })
    } catch (error) {
      next(error)
    }
  })

  router.post('/', (req: Request, res: Response, next: NextFunction): void => {
    try {
      const body = req.body as { subject: string; verifier: string; weight: number; claim: string }
      res.status(201).json(repo.create(body))
    } catch (error) {
      next(error)
    }
  })

  router.delete('/:id', (req: Request, res: Response, next: NextFunction): void => {
    try {
      const revoked = repo.revoke(req.params.id)
      if (!revoked) {
        throw new NotFoundError('Attestation', req.params.id)
      }
      res.json(revoked)
    } catch (error) {
      next(error)
    }
  })

  return router
}

export function createAttestationRouter(
  deps: AttestationRouterDeps | LegacyAttestationRepository = {}
): Router {
  if (isLegacyRepository(deps)) {
    return createLegacyAttestationRouter(deps)
  }

  const router = Router()
  const db = deps.db ?? pool
  const repository = deps.repository ?? new AttestationsRepository(db)
  const cacheService = deps.cacheService ?? new AttestationCacheService(repository)
  const transactionManager = deps.transactionManager ?? new TransactionManager(pool)
  const emitter = deps.outbox ?? outboxEmitter

  router.get(
    '/:address',
    validate({ params: attestationsPathParamsSchema }),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const { address } = req.validated!.params! as { address: string }
        const normalizedAddress = normalizeAddress(address)
        const { page, limit, offset } = parsePaginationParams(req.query as Record<string, unknown>)
        const result = await cacheService.getAttestationsBySubjectPage(normalizedAddress, {
          offset,
          limit,
        })

        res.json({
          address: normalizedAddress,
          attestations: result.attestations.map(serializeAttestation),
          offset,
          ...buildPaginationMeta(result.total, page, limit),
        })
      } catch (error) {
        if (error instanceof PaginationValidationError) {
          next(new ValidationError('Validation failed', error.details))
          return
        }
        next(error)
      }
    }
  )

  router.post(
    '/',
    validate({ body: createAttestationBodySchema }),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      const body = req.validated!.body! as CreateAttestationBody
      if (body.bondId === undefined || body.attesterAddress === undefined) {
        next(new ValidationError('Validation failed', [
          ...(body.bondId === undefined
            ? [{ path: 'bondId', message: 'Bond ID is required' }]
            : []),
          ...(body.attesterAddress === undefined
            ? [{ path: 'attesterAddress', message: 'Attester address is required' }]
            : []),
        ]))
        return
      }

      const input: CreateAttestationInput = {
        bondId: body.bondId,
        attesterAddress: normalizeAddress(body.attesterAddress),
        subjectAddress: normalizeAddress(body.subject),
        score: body.score ?? 100,
        note: buildNote(body),
      }

      try {
        const attestation = await transactionManager.withTransaction(async (client: PoolClient) => {
          const txRepository = new AttestationsRepository(client)
          const created = await txRepository.create(input)

          await emitter.emit(client, {
            aggregateType: 'attestation',
            aggregateId: String(created.id),
            eventType: 'attestation.created',
            payload: serializeAttestation(created),
          })

          return created
        })

        await cacheService.invalidateForAttestation(attestation)
        res.status(201).json(serializeAttestation(attestation))
      } catch (error) {
        if (isDuplicateAttestationError(error)) {
          res.status(409).json({
            error: 'Duplicate attestation',
            code: ErrorCode.VALIDATION_FAILED,
          })
          return
        }
        next(error)
      }
    }
  )

  return router
}

export default createAttestationRouter
