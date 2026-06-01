import crypto from 'crypto'
import { kekManager } from '../keyManager/index.js'

export type Role = 'USER' | 'ARBITRATOR' | 'GOVERNANCE'

export interface EvidenceRecord {
  evidence_id: string
  encryptedBlob: string
  iv: string
  authTag: string
  uploaderId: string
  createdAt: Date
  /** KEK version used to encrypt this record. Defaults to 1 for legacy records. */
  kek_version: number
}

// Using an in-memory map to simulate the DB for this service layer
export const evidenceDB = new Map<string, EvidenceRecord>()

/**
 * Service for securely storing and retrieving dispute/slash evidence.
 * Implements AES-256-GCM encryption at rest and Role-Based Access Control.
 *
 * Encryption uses the current active KEK from KekManager (envelope encryption).
 * When no KEK versions are registered, falls back to EVIDENCE_ENCRYPTION_KEY env var (legacy mode).
 * Legacy records without kek_version are treated as version 1.
 */
export class EvidenceStorageService {
  private readonly algorithm = 'aes-256-gcm'

  constructor() {
    // In legacy mode (no KekManager versions), validate the env var at construction time
    // to preserve backward-compatible fail-fast behaviour.
    if (kekManager.getAllVersions().length === 0) {
      const secret = process.env.EVIDENCE_ENCRYPTION_KEY
      if (!secret || Buffer.from(secret, 'utf-8').length !== 32) {
        throw new Error('EVIDENCE_ENCRYPTION_KEY must be exactly 32 bytes long.')
      }
    }
  }

  private getKey(version: number): Buffer {
    try {
      return kekManager.getVersion(version).keyMaterial
    } catch {
      // Fallback: legacy single-key mode
      const secret = process.env.EVIDENCE_ENCRYPTION_KEY
      if (!secret || Buffer.from(secret, 'utf-8').length !== 32) {
        throw new Error('EVIDENCE_ENCRYPTION_KEY must be exactly 32 bytes long.')
      }
      return Buffer.from(secret, 'utf-8')
    }
  }

  private getCurrentKey(): { key: Buffer; version: number } {
    try {
      const kek = kekManager.getCurrentKek()
      return { key: kek.keyMaterial, version: kek.version }
    } catch {
      // Fallback: legacy single-key mode
      const secret = process.env.EVIDENCE_ENCRYPTION_KEY
      if (!secret || Buffer.from(secret, 'utf-8').length !== 32) {
        throw new Error('EVIDENCE_ENCRYPTION_KEY must be exactly 32 bytes long.')
      }
      return { key: Buffer.from(secret, 'utf-8'), version: 1 }
    }
  }

  /**
   * Encrypts and stores evidence using the current active KEK.
   */
  public async uploadEvidence(
    evidenceId: string,
    rawData: string,
    uploaderId: string,
  ): Promise<EvidenceRecord> {
    if (!evidenceId || evidenceId.trim().length === 0 || /\s/.test(evidenceId)) {
      throw new Error('Invalid evidence id')
    }
    if (evidenceDB.has(evidenceId)) {
      throw new Error('Evidence already exists')
    }

    const { key, version } = this.getCurrentKey()
    const iv = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv(this.algorithm, key, iv)

    let encrypted = cipher.update(rawData, 'utf8', 'hex')
    encrypted += cipher.final('hex')
    const authTag = cipher.getAuthTag().toString('hex')

    const record: EvidenceRecord = {
      evidence_id: evidenceId,
      encryptedBlob: encrypted,
      iv: iv.toString('hex'),
      authTag: authTag,
      uploaderId,
      createdAt: new Date(),
      kek_version: version,
    }

    evidenceDB.set(evidenceId, record)
    return record
  }

  /**
   * Retrieves and decrypts evidence if the requesting role is authorized.
   * Automatically selects the correct KEK version from the record.
   */
  public async retrieveEvidence(evidenceId: string, role: Role): Promise<string> {
    if (!evidenceId || evidenceId.trim().length === 0 || /\s/.test(evidenceId)) {
      throw new Error('Invalid evidence id')
    }

    this.enforceAccessControl(role)

    const record = evidenceDB.get(evidenceId)
    if (!record) {
      throw new Error('Evidence not found')
    }

    const key = this.getKey(record.kek_version ?? 1)
    const decipher = crypto.createDecipheriv(
      this.algorithm,
      key,
      Buffer.from(record.iv, 'hex'),
    )

    decipher.setAuthTag(Buffer.from(record.authTag, 'hex'))

    let decrypted = decipher.update(record.encryptedBlob, 'hex', 'utf8')
    decrypted += decipher.final('utf8')

    return decrypted
  }

  /** Enforces RBAC - Only ARBITRATOR and GOVERNANCE can view evidence. */
  private enforceAccessControl(role: Role): void {
    const allowedRoles: Role[] = ['ARBITRATOR', 'GOVERNANCE']
    if (!allowedRoles.includes(role)) {
      throw new Error('Unauthorized: Insufficient role permissions')
    }
  }
}
