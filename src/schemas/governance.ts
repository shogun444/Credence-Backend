import { z } from 'zod'
import { stellarAddressSchema } from './address.js'

/**
 * Valid vote choices for slash requests
 */
export const voteChoiceSchema = z.enum(['approve', 'reject'])
export type VoteChoice = z.infer<typeof voteChoiceSchema>

/**
 * Body schema for POST /api/governance/slash-requests
 */
export const createSlashRequestBodySchema = z.object({
  targetAddress: stellarAddressSchema,
  reason: z.string().min(1, 'Reason is required').max(1000, 'Reason must be at most 1000 characters'),
  requestedBy: stellarAddressSchema,
  threshold: z.number().int().min(1, 'Threshold must be at least 1').optional(),
  totalSigners: z.number().int().min(1, 'Total signers must be at least 1').optional(),
}).strict()

export type CreateSlashRequestBody = z.infer<typeof createSlashRequestBodySchema>

/**
 * Body schema for POST /api/governance/slash-requests/:id/votes
 */
export const submitVoteBodySchema = z.object({
  voterId: stellarAddressSchema,
  choice: voteChoiceSchema,
}).strict()

export type SubmitVoteBody = z.infer<typeof submitVoteBodySchema>

/**
 * Path params for governance endpoints
 */
export const slashRequestIdParamsSchema = z.object({
  id: z.string().min(1, 'Slash request ID is required'),
})

export type SlashRequestIdParams = z.infer<typeof slashRequestIdParamsSchema>
