## Description

This PR externalizes hardcoded reputation scoring constants into versioned configuration, enabling model tuning without code changes and providing an audit trail.

## Changes

### Configuration
- Added `REPUTATION_MODEL_VERSION` for tracking scoring model versions
- Added `REPUTATION_BOND_SCORE_MAX` (default: 50)
- Added `REPUTATION_DURATION_SCORE_MAX` (default: 20)
- Added `REPUTATION_ATTESTATION_SCORE_MAX` (default: 30)
- Added `REPUTATION_ONE_ETH_WEI` (default: 1000000000000000000)
- Added `REPUTATION_MAX_DURATION_DAYS` (default: 365)
- Added `REPUTATION_MAX_ATTESTATION_COUNT` (default: 5)

### Code Changes
- Updated `src/config/index.ts` with Zod validation for reputation config
- Refactored `src/services/reputationService.ts` to accept optional config parameter
- Updated `src/jobs/scoreSnapshot.ts` to record `scoringModelVersion` in snapshots
- Made scoring functions pure and parameterized

### Tests
- Added `src/config/reputation.test.ts` with comprehensive config validation tests
- Added `src/services/reputationService.test.ts` with config-driven scoring tests
- Tests cover: defaults, custom values, validation, edge cases, and regression

### Documentation
- Updated `.env.example` with all reputation config variables
- Updated `src/services/reputation/README.md` with configuration guide

## Backward Compatibility
✅ Default values match original hardcoded constants
✅ Existing behavior preserved when no config overrides provided
✅ All scoring functions remain pure and testable

## Testing
- Config validation tests ensure invalid values are rejected at boot
- Regression tests verify default config matches original behavior
- Edge case tests cover boundary conditions

## Security
- Config validated with Zod at startup
- Invalid config causes application to fail fast with clear error messages
- No eval or dynamic code execution
