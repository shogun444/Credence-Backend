import { Router, Request, Response } from 'express'
import { SettlementsRepository } from '../db/repositories/settlementsRepository.js'
import { parsePaginationParams, encodeCursor, buildCursorEnvelope, PaginationValidationError } from '../lib/pagination.js'
import { pool } from '../db/pool.js'
import { ValidationError } from '../lib/errors.js'

/**
 * Creates the transactions router for history and reporting.
 */
export function createTransactionsRouter(): Router {
  const router = Router()
  const settlementsRepo = new SettlementsRepository(pool)

  /**
   * GET /api/transactions/history
   * 
   * Fetches transaction history (settlements) with stable cursor-based pagination.
   * Returns standardized cursor pagination envelope.
   */
  router.get('/history', async (req: Request, res: Response, next) => {
    try {
      const { limit, decodedCursor } = parsePaginationParams(req.query as Record<string, unknown>)
      const bondId = req.query.bondId as string | undefined

      // Fetch limit + 1 to determine if there are more results
      const settlements = await settlementsRepo.findManyPaginated({
        limit: limit + 1,
        cursor: decodedCursor,
        bondId,
      })

      const hasMore = settlements.length > limit
      const data = settlements.slice(0, limit)

      let nextCursor: string | null = null
      if (hasMore && data.length > 0) {
        const last = data[data.length - 1]
        nextCursor = encodeCursor(last.settledAt.toISOString(), last.id)
      }

      const envelope = buildCursorEnvelope(data, {
        limit,
        hasMore,
        nextCursor,
      })

      res.status(200).json({
        success: true,
        ...envelope,
      })
    } catch (error) {
      if (error instanceof PaginationValidationError) {
        next(new ValidationError('Validation failed', error.details))
        return
      }
      next(error)
    }
  })

  return router
}

export default createTransactionsRouter
