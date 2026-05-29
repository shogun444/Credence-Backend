# Security Architecture

## API Key Scope Model

### Granular Scopes (Least Privilege)

Every API key is issued with an explicit set of **scopes** that determine which endpoints it may call. The middleware enforces a **deny-by-default** policy: if the key's granted scopes do not cover the required scope, the request is rejected with `403 Forbidden` before reaching any handler.

| Scope                | Grants access to                                                   |
|----------------------|--------------------------------------------------------------------|
| `trust:read`         | Trust scores and bond read endpoints                               |
| `attestations:read`  | Attestation list and count endpoints                               |
| `attestations:write` | Create and revoke attestations                                     |
| `payouts:write`      | Payout / settlement creation                                       |
| `reports:generate`   | Report job creation and status polling                             |
| `exports:read`       | Report artifact downloads and audit-log exports                    |
| `webhooks:admin`     | Webhook secret rotation and revocation                             |
| `admin:read`         | Admin read operations (users, audit logs, failed events)           |
| `admin:write`        | Admin write operations (role assignment, key revocation, impersonation, event replay) |

Legacy `public` and `enterprise` values are still accepted and automatically expanded to their respective scope sets (see `docs/api-keys.md`).

### Scope Enforcement Implementation

`src/middleware/auth.ts` exports:

- **`ApiScope`** — enum of all valid scope strings.
- **`SCOPE_SETS`** — maps legacy tier names to their expanded `Set<ApiScope>`.
- **`scopeSatisfies(grantedScopes, requiredScope)`** — pure function; returns `true` when the granted set covers the required scope (including legacy expansion).
- **`requireApiKey(requiredScope)`** — Express middleware factory. Reads the key from `X-API-Key` or `Authorization: Bearer`, validates it, checks scope, and attaches `{ key, scopes, scope }` to `req.apiKey`.

### Scope Assignment at Key Creation

When issuing a key via `generateApiKey` / `InMemoryApiKeyRepository.create`, pass an explicit `scopes` array:

```typescript
repo.create('owner-id', 'trust:read', 'free', ['trust:read', 'attestations:read'])
```

The `scopes` array is stored on `StoredApiKey` and preserved through key rotation.

### Security Properties

- **Deny-by-default**: missing or insufficient scope → `403` before handler execution.
- **No scope escalation**: a key can only be rotated to the same or narrower scope set.
- **Audit trail**: every `403` response includes `requiredScope` and `grantedScopes` for debugging without leaking key material.
- **Backward compatibility**: existing `enterprise` keys continue to work and satisfy all granular scopes.

---

## Encrypted Evidence Storage

Dispute and slash evidence submitted to the platform often contain sensitive user data. To ensure privacy, security, and integrity, all evidence is encrypted at rest before being saved to the database or object storage.

### Encryption Standard
- **Algorithm**: AES-256-GCM (Galois/Counter Mode).
- **Key Management**: Managed via environment variables (`EVIDENCE_ENCRYPTION_KEY`). It must be exactly 32 bytes.
- **Integrity Validation**: GCM provides an authentication tag (`authTag`). During decryption, this tag ensures the data has not been tampered with or corrupted in the storage layer.

### Access Control (RBAC)
Access to decrypted evidence is strictly limited using Role-Based Access Control.
- **USER**: Denied access to view encrypted evidence blobs.
- **ARBITRATOR**: Granted access to retrieve and decrypt evidence for reviewing active disputes.
- **GOVERNANCE**: Granted access to retrieve and decrypt evidence for auditing, slashing events, and platform management.

### Evidence Audit Trail

All sensitive evidence actions are written to the immutable audit stream:

## API Key Handling (Integrations)

- **Hashed storage**: API keys are never stored in plain text. Only a SHA-256 hash of the raw key is persisted.
- **Shown once**: The raw key is returned exactly once at creation/rotation and must be stored securely by the integrator.
- **Timing-safe validation**: Key comparisons are performed via constant-time hash checks to avoid timing attacks; raw keys are not logged.
- **Rotation & revocation**: Keys can be rotated or revoked. Rotation issues a new raw key and revokes the previous one; revocation immediately prevents further access.
- **Test isolation**: Tests should generate keys via the API/key-service helpers and must reset the in-memory store between runs.

Never commit raw API keys, test fixtures with live keys, or example bearer tokens to source control or documentation. Use placeholder values or generated keys in tests and CI only.

- `EVIDENCE_UPLOADED` when evidence is stored
- `EVIDENCE_ACCESSED` when evidence is decrypted and returned

Each event includes actor metadata, action name, timestamp, and evidence resource id, enabling compliance queries by actor, resource, and time range.

## Rate Limiting

### Architecture

Rate limiting is enforced in `src/middleware/rateLimit.ts` using Redis fixed-window counters. Two independent counters are maintained per request:

1. **Tenant bucket** — keyed by `ratelimit:<namespace>:tenant:<ownerId>:<windowStart>`. Enforces the tier ceiling shared across all API keys belonging to the same owner.
2. **Per-key bucket** — keyed by `ratelimit:<namespace>:key:<keyId>:<windowStart>`. Enforces the same tier ceiling scoped to a single API key, preventing one noisy key from exhausting the shared tenant budget.

A request is rejected (HTTP 429) when **either** counter exceeds the limit for the request's subscription tier.

### Fail-closed mode (production default)

When Redis is unavailable the middleware behaviour is controlled by `RATE_LIMIT_FAIL_OPEN`:

- **`false` (default in `NODE_ENV=production`)** — the middleware returns `503 Service Unavailable`. This is the secure default: a Redis outage cannot be exploited to bypass rate limits.
- **`true` (default in `development` / `test`)** — the middleware passes the request through. Useful for local development where Redis may not always be running.

The catch-block fallback in `src/app.ts` also derives `failOpen` from `NODE_ENV`, so a `validateConfig` failure at startup cannot silently disable limits in production.

### Prometheus metric

`rate_limit_rejected_total` (counter) is incremented on every rejected request with labels:

| Label | Values |
|-------|--------|
| `tier` | `free`, `pro`, `enterprise` |
| `key_id` | API key id, or `none` |
| `reason` | `tenant_limit`, `key_limit`, `redis_unavailable` |

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `RATE_LIMIT_ENABLED` | `true` | Enable / disable rate limiting |
| `RATE_LIMIT_WINDOW_SEC` | `60` | Fixed-window size in seconds |
| `RATE_LIMIT_MAX_FREE` | `100` | Max requests per window for free tier |
| `RATE_LIMIT_MAX_PRO` | `1000` | Max requests per window for pro tier |
| `RATE_LIMIT_MAX_ENTERPRISE` | `10000` | Max requests per window for enterprise tier |
| `RATE_LIMIT_FAIL_OPEN` | `false` in prod, `true` in dev/test | Fail-open (`true`) or fail-closed (`false`) on Redis error |

### Security considerations

- **Misconfiguration cannot disable limits in production.** The `RATE_LIMIT_FAIL_OPEN` default is `false` when `NODE_ENV=production`, and the startup fallback in `src/app.ts` mirrors this.
- **Key identifiers are never stored in plain text.** When no authenticated record is present, the tenant id is derived from a truncated SHA-256 hash of the API key or Bearer token.
- **Per-key isolation** ensures that a compromised or misbehaving key cannot exhaust the rate budget of other keys belonging to the same tenant.
