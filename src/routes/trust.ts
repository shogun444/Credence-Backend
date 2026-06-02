import { Router, type Request, type Response, type NextFunction } from 'express'
import { getTrustScore } from '../services/reputationService.js'
import { PgTrustIdentityRepository } from '../db/repositories/trustIdentityRepository.js'
import { pool, withReplica } from '../db/pool.js'
import { apiKeyMiddleware } from '../middleware/apiKey.js'
import { validate } from '../middleware/validate.js'
import { trustPathParamsSchema } from '../schemas/index.js'
import { NotFoundError } from '../lib/errors.js'

const router = Router()

router.get(
  '/:address',
  validate({ params: trustPathParamsSchema }),
  apiKeyMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { address } = req.validated!.params! as { address: string }

      const trustScore = await withReplica(async (client) => {
        const trustRepo = new PgTrustIdentityRepository(client)
        return await getTrustScore(address, trustRepo)
      })

      if (!trustScore) {
        throw new NotFoundError('Identity record', address)
      }

      res.json(trustScore)
    } catch (error) {
      next(error)
    }
  }
)

export default router