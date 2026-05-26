import { ReportRepository } from '../db/repositories/reportRepository.js'
import { ReportJob, ReportJobStatus } from '../jobs/types.js'
import { cache } from '../cache/redis.js'
import { invalidateCache } from '../cache/invalidation.js'

const REPORT_CACHE_TTL = 60 // 1 minute for active jobs

export class ReportService {
  constructor(private readonly reportRepository: ReportRepository) {}

  /**
   * Starts a report generation job asynchronously.
   */
  async startReportGeneration(type: string): Promise<ReportJob> {
    const job = await this.reportRepository.create(type)
    // Enqueue job for external durable worker; processing moved to ReportWorker
    return job
  }

  /**
   * Gets the status of a report job with caching.
   */
  async getReportStatus(id: string): Promise<ReportJob | null> {
    const cached = await cache.get<ReportJob>('report', id)
    
    if (cached) {
      return cached
    }
    
    const job = await this.reportRepository.findById(id)
    if (job) {
      // Cache with shorter TTL for active jobs
      const ttl = job.status === ReportJobStatus.COMPLETED || job.status === ReportJobStatus.FAILED 
        ? 300 // 5 minutes for terminal states
        : REPORT_CACHE_TTL
      await cache.set('report', id, job, ttl)
    }
    
    return job
  }

  /**
   * Update report status with cache invalidation.
   * Exposed so workers can notify status changes while preserving
   * cache invalidation behaviour.
   */
  async updateStatusWithInvalidation(
    id: string,
    status: ReportJobStatus,
    metadata?: any
  ): Promise<void> {
    await this.reportRepository.updateStatus(id, status, metadata)
    
    // Invalidate cache after status update
    const job = await this.reportRepository.findById(id)
    if (job) {
      await invalidateCache('report', id, job, {
        verify: true,
        verifyFn: (cached, fresh) => cached.status !== fresh.status
      })
    }
  }
}
