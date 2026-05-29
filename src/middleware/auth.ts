import { Request, Response, NextFunction } from 'express'
import type { StoredApiKey } from '../services/apiKeys.js'
import { validateApiKey } from '../services/apiKeys.js'
import { userRepo } from '../repositories/userRepository.js'
import { requireApiKey as requireApiKeyFromApiKeyMiddleware } from './apiKey.js'

/**
 * API key scopes for authorization
 */
export enum ApiScope {
  PUBLIC = 'public',
  ENTERPRISE = 'enterprise',
}

/**
 * User roles for role-based access control
 */
export enum UserRole {
  SUPER_ADMIN = 'super-admin',
  ADMIN = 'admin',
  VERIFIER = 'verifier',
  USER = 'user',
}

/**
 * Extended Express Request with API key and user metadata
 */
export interface AuthenticatedRequest extends Request {
  apiKey?: StoredApiKey
  user?: {
    id: string
    role: UserRole
    email: string
    tenantId: string
  }
}

// Note: legacy in-source mocks were removed. Keys are validated against the
// persisted hashed store via `validateApiKey`. User resolution is delegated
// to `userRepo` so records are sourced from a single place (tests may seed
// the in-memory repo).

/**
 * Middleware to validate API key and check required scope
 * 
 * @param requiredScope - Minimum scope required for the endpoint
 * @returns Express middleware function
 * 
 * @example
 * ```typescript
 * app.post('/api/bulk/verify', requireApiKey(ApiScope.ENTERPRISE), handler)
 * ```
 */
/**
 * Adapter to the canonical `requireApiKey` implemented in `src/middleware/apiKey.ts`.
 * Keeps the old `ApiScope` enum surface but delegates validation to the
 * DB-backed key validator. Mapping of scopes is performed below.
 */
export function requireApiKey(requiredScope: ApiScope) {
  // Map legacy ApiScope to service KeyScope values used by the canonical
  // middleware. PUBLIC -> 'read', ENTERPRISE -> 'full'.
  const mapped = requiredScope === ApiScope.ENTERPRISE ? 'full' : 'read'
  // Re-use the implementation in apiKey.ts which validates the hashed store
  return requireApiKeyFromApiKeyMiddleware(mapped as any)
}

/**
 * Middleware to check if user has admin role
 * Should be used after user authentication is established
 * 
 * @returns Express middleware function
 * 
 * @example
 * ```typescript
 * app.post('/api/admin/users', requireAdminRole, handler)
 * ```
 */
export function requireAdminRole(req: Request, res: Response, next: NextFunction): void {
  const authReq = req as AuthenticatedRequest

  if (!authReq.user) {
    res.status(401).json({
      error: 'Unauthorized',
      message: 'User authentication required',
    })
    return
  }

  if (authReq.user.role !== UserRole.ADMIN && authReq.user.role !== UserRole.SUPER_ADMIN) {
    res.status(403).json({
      error: 'Forbidden',
      message: 'Admin role required',
    })
    return
  }

  next()
}

/**
 * Middleware to authenticate user from Authorization header (Bearer token format)
 * Should be used before requireAdminRole
 * 
 * @returns Express middleware function
 * 
 * @example
 * ```typescript
 * app.use('/api/admin', requireUserAuth, requireAdminRole, adminRouter)
 * ```
 */
export function requireUserAuth(req: Request, res: Response, next: NextFunction): void {
  const authReq = req as AuthenticatedRequest
  const authHeader = req.headers.authorization

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Bearer token required',
    })
    return
  }

  const raw = authHeader.substring(7) // Remove 'Bearer ' prefix

  const key = validateApiKey(raw)
  if (!key) {
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Invalid or expired token',
    })
    return
  }

  // Resolve the user record from the repository. Tests and runtime should
  // seed `userRepo` with the expected records. If not found, treat as
  // unauthorized rather than silently creating a user.
  const user = userRepo.findById(key.ownerId)
  if (!user) {
    res.status(401).json({
      error: 'Unauthorized',
      message: 'User not found',
    })
    return
  }

  authReq.apiKey = key
  authReq.user = {
    id: user.id,
    role: user.role as UserRole,
    email: user.email,
    tenantId: user.tenantId,
  }

  next()
}
