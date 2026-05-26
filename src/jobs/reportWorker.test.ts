import { describe, it, expect, vi } from 'vitest'
import { ReportWorker } from './reportWorker.js'
import { ReportJobStatus } from '../jobs/types.js'

function makeRepo(claimed: any = null) {
  return {
    claimNextQueued: vi.fn().mockResolvedValue(claimed),
  }
}

function makeService() {
  return {
    updateStatusWithInvalidation: vi.fn().mockResolvedValue(undefined),
  }
}

function makeLock() {
  return {
    withLock: vi.fn().mockImplementation(async (_key: string, fn: any) => {
      const result = await fn()
      return { executed: true, result }
    }),
  }
}

describe('ReportWorker', () => {
  it('returns null when no queued jobs', async () => {
    const repo = makeRepo(null)
    const svc = makeService()
    const lock = makeLock()

    const worker = new ReportWorker(repo as any, svc as any, { distributedLock: lock as any })
    const res = await worker.run()

    expect(res).toBeNull()
    expect(repo.claimNextQueued).toHaveBeenCalled()
    expect(svc.updateStatusWithInvalidation).not.toHaveBeenCalled()
  })

  it('processes a claimed job and marks completed', async () => {
    const claimed = { id: 'job-1', type: 'summary' }
    const repo = makeRepo(claimed)
    const svc = makeService()
    const lock = makeLock()

    const worker = new ReportWorker(repo as any, svc as any, { distributedLock: lock as any })
    const res = await worker.run()

    expect(res).toEqual({ id: 'job-1', status: 'completed' })
    expect(repo.claimNextQueued).toHaveBeenCalled()
    expect(svc.updateStatusWithInvalidation).toHaveBeenCalledWith(
      'job-1',
      ReportJobStatus.COMPLETED,
      expect.objectContaining({ artifactUrl: expect.any(String) })
    )
  })
})
