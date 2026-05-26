import type { DistributedLock } from './distributedLock.js'
import type { ReportRepository } from '../db/repositories/reportRepository.js'
import type { ReportService } from '../services/reportService.js'
import { ReportJobStatus } from '../jobs/types.js'

export interface ReportWorkerOptions {
  distributedLock: DistributedLock
  lockKey?: string
  logger?: (msg: string) => void
}

/**
 * Durable report worker: claims queued report jobs and processes them
 * under a distributed lock so work is not duplicated across replicas.
 */
export class ReportWorker {
  private readonly lockKey: string
  private readonly logger: (msg: string) => void

  constructor(
    private readonly repo: ReportRepository,
    private readonly service: ReportService,
    private readonly opts: ReportWorkerOptions,
  ) {
    this.lockKey = opts.lockKey ?? 'report:worker'
    this.logger = opts.logger ?? (() => {})
  }

  /**
   * Attempt to claim and process a single queued report job.
   * Returns the worker result or null if no work claimed or lock not acquired.
   */
  async run(): Promise<null | { id: string; status: string }> {
    const { distributedLock } = this.opts

    const { executed, result } = await distributedLock.withLock(
      this.lockKey,
      async () => {
        this.logger(`[ReportWorker] scanning for queued jobs`)

        const claimed = await this.repo.claimNextQueued()
        if (!claimed) {
          this.logger('[ReportWorker] no queued jobs')
          return null
        }

        this.logger(`[ReportWorker] claimed job ${claimed.id}, processing`)

        try {
          // TODO: Replace stubbed artifact generation with real report builder.
          const artifactUrl = `https://artifacts.credence.example.com/reports/${claimed.id}.pdf`

          await this.service.updateStatusWithInvalidation(
            claimed.id,
            ReportJobStatus.COMPLETED,
            { artifactUrl }
          )

          this.logger(`[ReportWorker] completed job ${claimed.id}`)
          return { id: claimed.id, status: 'completed' }
        } catch (err) {
          this.logger(`[ReportWorker] job ${claimed.id} failed: ${String(err)}`)
          await this.service.updateStatusWithInvalidation(
            claimed.id,
            ReportJobStatus.FAILED,
            { failureReason: 'INTERNAL_ERROR' }
          )
          return null
        }
      },
      { ttlMs: 60_000 }
    )

    if (!executed) return null
    return result ?? null
  }
}

export default ReportWorker
