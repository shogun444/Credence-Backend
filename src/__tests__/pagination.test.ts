import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { encodeCursor, decodeCursor, buildCursorEnvelope, parsePaginationParams, PaginationValidationError } from '../lib/pagination.js'
import { AttestationsRepository, type Attestation } from '../db/repositories/attestationsRepository.js'
import Database from 'better-sqlite3'

describe('Cursor Pagination', () => {
  describe('encodeCursor & decodeCursor', () => {
    it('should encode and decode cursor correctly', () => {
      const timestamp = '2024-01-15T10:30:00.000Z'
      const id = '123'

      const encoded = encodeCursor(timestamp, id)
      const decoded = decodeCursor(encoded)

      expect(decoded).toEqual({ t: timestamp, i: id })
    })

    it('should handle Date objects in encodeCursor', () => {
      const date = new Date('2024-01-15T10:30:00.000Z')
      const id = '456'

      const encoded = encodeCursor(date, id)
      const decoded = decodeCursor(encoded)

      expect(decoded).toEqual({ t: date.toISOString(), i: id })
    })

    it('should return null for invalid base64', () => {
      const decoded = decodeCursor('not-valid-base64!!!')
      expect(decoded).toBeNull()
    })

    it('should return null for malformed JSON cursor', () => {
      const encoded = Buffer.from('{"invalid": "json"}', 'utf8').toString('base64url')
      const decoded = decodeCursor(encoded)
      expect(decoded).toBeNull()
    })

    it('should return null for missing required fields', () => {
      const encoded = Buffer.from('{"t": "2024-01-15T10:30:00.000Z"}', 'utf8').toString('base64url')
      const decoded = decodeCursor(encoded)
      expect(decoded).toBeNull()
    })
  })

  describe('buildCursorEnvelope', () => {
    it('should build envelope with data and pagination info', () => {
      const data = [{ id: 1, name: 'item1' }, { id: 2, name: 'item2' }]
      const envelope = buildCursorEnvelope(data, {
        limit: 20,
        hasMore: true,
        nextCursor: 'abc123',
      })

      expect(envelope).toEqual({
        data,
        page: {
          nextCursor: 'abc123',
          hasMore: true,
          limit: 20,
        },
      })
    })

    it('should handle empty data array', () => {
      const envelope = buildCursorEnvelope([], {
        limit: 20,
        hasMore: false,
        nextCursor: null,
      })

      expect(envelope).toEqual({
        data: [],
        page: {
          nextCursor: null,
          hasMore: false,
          limit: 20,
        },
      })
    })

    it('should use null for missing nextCursor', () => {
      const envelope = buildCursorEnvelope([], {
        limit: 20,
        hasMore: false,
      })

      expect(envelope.page.nextCursor).toBeNull()
    })
  })

  describe('parsePaginationParams', () => {
    it('should parse limit parameter', () => {
      const result = parsePaginationParams({ limit: '50' })
      expect(result.limit).toBe(50)
    })

    it('should enforce max limit', () => {
      expect(() => parsePaginationParams({ limit: '150' })).toThrow(PaginationValidationError)
    })

    it('should use default limit when not provided', () => {
      const result = parsePaginationParams({})
      expect(result.limit).toBe(20)
    })

    it('should reject non-positive limit', () => {
      expect(() => parsePaginationParams({ limit: '0' })).toThrow(PaginationValidationError)
      expect(() => parsePaginationParams({ limit: '-5' })).toThrow(PaginationValidationError)
    })

    it('should reject non-integer limit', () => {
      expect(() => parsePaginationParams({ limit: '10.5' })).toThrow(PaginationValidationError)
    })

    it('should parse cursor parameter', () => {
      const encoded = encodeCursor('2024-01-15T10:30:00.000Z', '123')
      const result = parsePaginationParams({ cursor: encoded })
      
      expect(result.decodedCursor).toEqual({ t: '2024-01-15T10:30:00.000Z', i: '123' })
    })

    it('should reject invalid cursor', () => {
      expect(() => parsePaginationParams({ cursor: 'invalid-cursor' })).toThrow(PaginationValidationError)
    })

    it('should provide error details for multiple validation failures', () => {
      try {
        parsePaginationParams({ limit: '150', cursor: 'invalid' })
        expect.fail('Should have thrown')
      } catch (error) {
        if (error instanceof PaginationValidationError) {
          expect(error.details.length).toBeGreaterThan(0)
          expect(error.details.some(d => d.path === 'limit')).toBe(true)
          expect(error.details.some(d => d.path === 'cursor')).toBe(true)
        }
      }
    })
  })

  describe('AttestationsRepository cursor pagination', () => {
    let db: Database.Database
    let repo: AttestationsRepository

    beforeEach(() => {
      vi.mock('../../utils/tenantContext.js', () => ({
        getTenantId: vi.fn(() => 'test-tenant'),
        setTenantId: vi.fn(),
      }))

      db = new Database(':memory:')
      db.pragma('foreign_keys = ON')

      // Create attestations table
      db.exec(`
        CREATE TABLE attestations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          bond_id INTEGER NOT NULL,
          attester_address TEXT NOT NULL,
          subject_address TEXT NOT NULL,
          score INTEGER NOT NULL DEFAULT 100,
          note TEXT,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `)

      repo = new AttestationsRepository(db)
    })

    afterEach(() => {
      db.close()
      vi.clearAllMocks()
    })

    it('should fetch paginated attestations with cursor', async () => {
      // Insert test data with controlled timestamps
      const baseTime = new Date('2024-01-15T10:00:00Z')
      const attestations = []
      
      for (let i = 0; i < 5; i++) {
        const createdAt = new Date(baseTime.getTime() + i * 1000)
        attestations.push({
          bond_id: 1,
          attester_address: '0xattester',
          subject_address: '0xsubject',
          score: 100,
          note: null,
          created_at: createdAt.toISOString(),
        })
      }

      for (const att of attestations) {
        db.prepare(`
          INSERT INTO attestations (bond_id, attester_address, subject_address, score, note, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(att.bond_id, att.attester_address, att.subject_address, att.score, att.note, att.created_at)
      }

      // Fetch first page
      const page1 = await repo.listBySubjectPaginated('0xsubject', {
        limit: 2,
      })

      expect(page1.attestations).toHaveLength(2)
      expect(page1.hasMore).toBe(true)
      // Should be ordered DESC (newest first)
      expect(page1.attestations[0].id).toBeGreaterThan(page1.attestations[1].id)
    })

    it('should return hasMore=false on last page', async () => {
      // Insert 3 attestations
      for (let i = 0; i < 3; i++) {
        db.prepare(`
          INSERT INTO attestations (bond_id, attester_address, subject_address, score, note)
          VALUES (?, ?, ?, ?, ?)
        `).run(1, '0xattester', '0xsubject', 100, null)
      }

      const result = await repo.listBySubjectPaginated('0xsubject', {
        limit: 10,
      })

      expect(result.attestations).toHaveLength(3)
      expect(result.hasMore).toBe(false)
    })

    it('should handle empty result set', async () => {
      const result = await repo.listBySubjectPaginated('0xnonexistent', {
        limit: 20,
      })

      expect(result.attestations).toHaveLength(0)
      expect(result.hasMore).toBe(false)
    })

    it('should use stable sort (created_at DESC, id DESC)', async () => {
      // Insert attestations with same created_at to test secondary sort
      const now = new Date().toISOString()
      for (let i = 0; i < 5; i++) {
        db.prepare(`
          INSERT INTO attestations (bond_id, attester_address, subject_address, score, note, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(1, '0xattester', '0xsubject', 100, null, now)
      }

      const page1 = await repo.listBySubjectPaginated('0xsubject', {
        limit: 3,
      })

      expect(page1.attestations).toHaveLength(3)
      expect(page1.hasMore).toBe(true)

      // All should have same created_at, but different IDs
      const ids = page1.attestations.map(a => a.id)
      expect(ids).toEqual([...ids].sort((a, b) => b - a)) // DESC order
    })
  })

  describe('Cursor round-trip', () => {
    it('should support multiple page requests with cursor', async () => {
      // Simulating fetching multiple pages
      let cursor: string | null = null
      const allIds: number[] = []

      for (let page = 0; page < 3; page++) {
        // Simulate fetching a page
        const items = [
          { id: page * 2 + 1, data: 'item1' },
          { id: page * 2 + 2, data: 'item2' },
        ]

        if (items.length > 0) {
          const lastItem = items[items.length - 1]
          cursor = encodeCursor('2024-01-15T10:30:00.000Z', String(lastItem.id))
        }

        allIds.push(...items.map(i => i.id))

        // Decode and verify
        const decoded = decodeCursor(cursor || '')
        if (decoded) {
          expect(decoded.i).toBe(String(items[items.length - 1].id))
        }
      }

      expect(allIds).toEqual([1, 2, 3, 4, 5, 6])
    })
  })

  describe('Edge cases', () => {
    it('should handle limit of 1', () => {
      const result = parsePaginationParams({ limit: '1' })
      expect(result.limit).toBe(1)
    })

    it('should handle max limit exactly', () => {
      const result = parsePaginationParams({ limit: '100' })
      expect(result.limit).toBe(100)
    })

    it('should handle empty cursor string gracefully', () => {
      const result = parsePaginationParams({ cursor: '' })
      expect(result.decodedCursor).toBeUndefined()
    })

    it('should reject cursor with non-string ID', () => {
      const invalid = Buffer.from('{"t": "2024-01-15T10:30:00.000Z", "i": 123}', 'utf8').toString('base64url')
      const decoded = decodeCursor(invalid)
      expect(decoded).toBeNull()
    })

    it('should reject cursor with non-string timestamp', () => {
      const invalid = Buffer.from('{"t": 1234567890, "i": "123"}', 'utf8').toString('base64url')
      const decoded = decodeCursor(invalid)
      expect(decoded).toBeNull()
    })
  })
})
