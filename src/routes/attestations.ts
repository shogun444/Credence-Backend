/**
 * @module routes/attestations
 */

import { Router, type Request, type Response } from 'express';
import {
  buildCursorPaginationMeta,
  parsePaginationParams,
} from '../lib/pagination.js';
import { AttestationRepository } from '../repositories/attestationRepository.js';
import type {
  AttestationCountResponse,
  AttestationListResponse,
} from '../types/attestation.js';
import { NotFoundError } from '../lib/errors.js';
import { requireApiKey, ApiScope } from '../middleware/auth.js';

/**
 * Create and return an Express {@link Router} wired to the given
 * {@link AttestationRepository}.
 *
 * @param repo - The repository instance to delegate to.
 * @returns Configured Express router.
 */
export function createAttestationRouter(repo: AttestationRepository): Router {
  const router = Router();

  // ── GET /api/attestations/:identity/count ────────────────────────────
  router.get('/:identity/count', requireApiKey(ApiScope.ATTESTATIONS_READ), (req: Request, res: Response): void => {
    const { identity } = req.params;
    const includeRevoked = req.query.includeRevoked === 'true';

    const count = repo.countBySubject(identity, includeRevoked);

    const body: AttestationCountResponse = {
      identity,
      count,
      includeRevoked,
    };

    res.json(body);
  });

  // ── GET /api/attestations/:identity ──────────────────────────────────
  router.get('/:identity', requireApiKey(ApiScope.ATTESTATIONS_READ), (req: Request, res: Response, next): void => {
    const { identity } = req.params;
    const includeRevoked = req.query.includeRevoked === 'true';

    try {
      const { limit, cursor } = parsePaginationParams(req.query as Record<string, unknown>);

      // Fallback for backwards compat is handled inside pagination lib if cursor is an integer
      const { attestations, hasNextPage, nextCursor } = repo.findBySubject(identity, {
        includeRevoked,
        cursor: cursor ?? undefined,
        limit,
      });
      const paginationMeta = buildCursorPaginationMeta(hasNextPage, limit, nextCursor);

      const body = {
        identity,
        attestations,
        ...paginationMeta,
      };

      res.json(body);
    } catch (error) {
      next(error);
    }
  });

  // ── POST /api/attestations ───────────────────────────────────────────
  router.post('/', requireApiKey(ApiScope.ATTESTATIONS_WRITE), (req: Request, res: Response, next): void => {
    try {
      const { subject, verifier, weight, claim } = req.body as {
        subject: string;
        verifier: string;
        weight: number;
        claim: string;
      };

      const attestation = repo.create({ subject, verifier, weight, claim });
      res.status(201).json(attestation);
    } catch (err) {
      next(err);
    }
  });

  // ── DELETE /api/attestations/:id ─────────────────────────────────────
  router.delete('/:id', requireApiKey(ApiScope.ATTESTATIONS_WRITE), (req: Request, res: Response, next): void => {
    try {
      const result = repo.revoke(req.params.id);
      if (!result) {
        throw new NotFoundError('Attestation', req.params.id);
      }
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
