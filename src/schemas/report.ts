import { z } from 'zod'

/**
 * Allowed report types — single source of truth for the route and worker.
 * Add new report types here as they are implemented.
 */
export const REPORT_TYPES = [
  'trust_score_summary',
  'bond_audit',
  'attestation_export',
] as const

/**
 * Schema for a valid report type string.
 */
export const reportTypeSchema = z.enum(REPORT_TYPES)

/**
 * Body schema for POST /api/reports
 */
export const createReportBodySchema = z
  .object({
    type: reportTypeSchema,
  })
  .strict()

export type ReportType = z.infer<typeof reportTypeSchema>
export type CreateReportBody = z.infer<typeof createReportBodySchema>
