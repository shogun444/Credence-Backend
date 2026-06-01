import {
  Router,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import {
  getTrustScore,
  type TrustIdentityRepository,
} from "../services/reputationService.js";
import { ScoreHistoryRepository } from "../db/repositories/scoreHistoryRepository.js";
import { PgTrustIdentityRepository } from "../db/repositories/trustIdentityRepository.js";
import { pool } from "../db/pool.js";
import { apiKeyMiddleware } from "../middleware/apiKey.js";
import { validate } from "../middleware/validate.js";
import {
  trustExplainQuerySchema,
  trustPathParamsSchema,
} from "../schemas/index.js";
import { NotFoundError } from "../lib/errors.js";
import {
  calculatePersistedReputationScore,
  calculateReputationScore,
} from "../services/reputation/score.js";

interface TrustRouterDeps {
  trustRepo?: TrustIdentityRepository;
  scoreHistoryRepo?: ScoreHistoryRepository;
}

const normalizeAddress = (address: string): string =>
  address.startsWith("0x") ? address.toLowerCase() : address;

function createTrustRouter(deps: TrustRouterDeps = {}): Router {
  const router = Router();
  const trustRepo = deps.trustRepo ?? new PgTrustIdentityRepository(pool);
  const scoreHistoryRepo =
    deps.scoreHistoryRepo ?? new ScoreHistoryRepository(pool);

  router.get(
    "/:address/explain",
    validate({ params: trustPathParamsSchema, query: trustExplainQuerySchema }),
    apiKeyMiddleware,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { address } = req.validated!.params! as { address: string };
        const { snapshotId } = req.validated!.query! as { snapshotId: number };
        const normalizedAddress = normalizeAddress(address);

        const snapshot = await scoreHistoryRepo.findById(snapshotId);
        if (
          !snapshot ||
          normalizeAddress(snapshot.identityAddress) !== normalizedAddress
        ) {
          throw new NotFoundError("Score snapshot", String(snapshotId));
        }

        const recomputed = calculateReputationScore(snapshot.inputVector);
        const expectedScore = calculatePersistedReputationScore(
          snapshot.inputVector,
        );

        res.json({
          id: snapshot.id,
          identityAddress: snapshot.identityAddress,
          score: snapshot.score,
          source: snapshot.source,
          computedAt: snapshot.computedAt.toISOString(),
          inputVector: snapshot.inputVector,
          recomputedScore: expectedScore,
          scoreMatchesSnapshot: expectedScore === snapshot.score,
          explanation: {
            bondScore: recomputed.bondScore,
            attestationScore: recomputed.attestationScore,
            timeWeight: recomputed.timeWeight,
          },
        });
      } catch (error) {
        next(error);
      }
    },
  );

  router.get(
    "/:address",
    validate({ params: trustPathParamsSchema }),
    apiKeyMiddleware,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { address } = req.validated!.params! as { address: string };

        const trustScore = await getTrustScore(address, trustRepo);

        if (!trustScore) {
          throw new NotFoundError("Identity record", address);
        }

        res.json(trustScore);
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
}
export default createTrustRouter();
