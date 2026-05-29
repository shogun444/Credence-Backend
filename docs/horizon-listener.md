# Horizon Listener - Bond and Withdrawal Events

This document describes the Horizon event listeners implementation for the Credence Backend, including durable cursor checkpointing for gap-free event processing.

## Overview

The Horizon event listeners monitor the Stellar blockchain for bond creation and withdrawal transactions, maintaining consistency between on-chain state and the application database. With durable cursor checkpointing, the listeners can resume from their last processed event after any restart, crash, or redeploy, ensuring no events are silently dropped.

## Key Features

- **Durable Cursor Checkpointing** - Persists the last processed `paging_token` to database
- **Gap-Free Resume** - Resumes from saved cursor after restart, crash, or redeploy
- **Transactional Consistency** - Cursor updates are transactional with event processing
- **Prometheus Metrics** - Exposes cursor lag and checkpoint timestamp metrics
- **Multiple Stream Support** - Independent cursors for bond_creation, bond_withdrawal, and attestation streams

## Architecture

### Cursor Checkpointing System

The cursor checkpointing system ensures gap-free event processing across restarts:

```
┌─────────────────┐
│ Horizon Stream  │
│  (Stellar)      │
└────────┬────────┘
         │ events
         ▼
┌─────────────────┐
│ Event Listener  │
│ (Bond/Withdraw) │
└────────┬────────┘
         │
         ├─► Process Event
         │   (upsert identity/bond)
         │
         └─► Persist Cursor
             (transactional)
                 │
                 ▼
         ┌───────────────┐
         │ horizon_cursors│
         │     table      │
         └───────────────┘
```

### HorizonWithdrawalListener

The main class that handles Horizon event streaming and bond state updates:

```ts
import { createHorizonWithdrawalListener } from '../listeners/horizonWithdrawalEvents.js'
import { pool } from '../db/pool.js'
import { replayService } from '../services/replay.js'

const listener = createHorizonWithdrawalListener(
  {
    horizonUrl: 'https://horizon-testnet.stellar.org',
    pollingInterval: 5000,
    bondContractAddress: 'GABCD...'
  },
  pool,
  replayService
)

await listener.start()
```

### Bond Creation Listener

Subscribe to bond creation events with cursor checkpointing:

```ts
import { subscribeBondCreationEvents } from '../listeners/horizonBondEvents.js'
import { pool } from '../db/pool.js'

await subscribeBondCreationEvents(pool, (event) => {
  console.log('Bond created:', event)
})
```

### Key Components

- **Connection Management** - Handles Horizon server connection and reconnection
- **Event Polling** - Polls Horizon for new operations
- **Cursor Persistence** - Saves paging_token after each successful event
- **Bond State Updates** - Updates bond records based on events
- **Score Snapshots** - Creates score history snapshots for significant withdrawals
- **Error Handling** - Graceful handling of API errors and network issues
- **Metrics Emission** - Exposes cursor lag and checkpoint metrics

## Cursor Checkpointing

### Database Schema

The `horizon_cursors` table stores durable checkpoints:

```sql
CREATE TABLE horizon_cursors (
  stream_name       TEXT        PRIMARY KEY,
  paging_token      TEXT        NOT NULL,
  last_checkpoint   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### Stream Names

- `bond_creation` - Bond creation events
- `bond_withdrawal` - Bond withdrawal events
- `attestation` - Attestation events

### Cursor Lifecycle

1. **First Boot** - No saved cursor exists, starts from `'now'`
2. **Event Processing** - Processes event and updates database
3. **Cursor Persistence** - Saves `paging_token` transactionally
4. **Restart** - Loads saved cursor and resumes from that point
5. **Gap-Free Replay** - Processes all events since last checkpoint

### CursorRepository API

```ts
import { CursorRepository } from '../db/repositories/cursorRepository.js'
import { pool } from '../db/pool.js'

const cursorRepo = new CursorRepository(pool)

// Load saved cursor
const cursor = await cursorRepo.findByStreamName('bond_creation')
// Returns: { streamName, pagingToken, lastCheckpoint, ... } or null

// Save cursor checkpoint
await cursorRepo.upsert({
  streamName: 'bond_creation',
  pagingToken: '12345678901234'
})

// Get cursor lag in seconds
const lag = await cursorRepo.getCursorLag('bond_creation')
// Returns: number of seconds since last checkpoint
```

## Configuration

### HorizonListenerConfig

```ts
interface HorizonListenerConfig {
  horizonUrl: string              // Horizon server URL
  networkPassphrase: string        // Stellar network passphrase
  bondContractAddress?: string    // Optional bond contract address
  withdrawalAsset?: {             // Optional specific withdrawal asset
    code: string
    issuer: string
  }
  pollingInterval?: number        // Polling interval in milliseconds
  lastCursor?: string            // Initial cursor (overridden by saved cursor)
}
```

### Environment Variables

```bash
# Horizon server URL
HORIZON_URL=https://horizon-testnet.stellar.org

# Stellar network passphrase
STELLAR_NETWORK_PASSPHRASE="Test SDF Network ; September 2015"

# Optional: Bond contract address
BOND_CONTRACT_ADDRESS=GABCD...

# Optional: Polling interval (milliseconds)
HORIZON_POLLING_INTERVAL=5000
```

## API Reference

### HorizonWithdrawalListener Methods

#### `start(): Promise<void>`

Start listening for withdrawal events.

```ts
await listener.start()
```

#### `stop(): Promise<void>`

Stop listening for withdrawal events.

```ts
await listener.stop()
```

#### `isActive(): boolean`

Check if the listener is currently running.

```ts
const isRunning = listener.isActive()
```

#### `getCursor(): string`

Get the current cursor position for resuming.

```ts
const cursor = listener.getCursor()
```

#### `setCursor(cursor: string): void`

Set the cursor position for resuming from a specific point.

```ts
listener.setCursor('123456789')
```

#### `getStats(): ListenerStats`

Get listener statistics and status.

```ts
const stats = listener.getStats()
// Returns: { isRunning, horizonUrl, lastCursor, pollingInterval }
```

## Event Processing

### Withdrawal Detection

The listener identifies withdrawal events by:

1. **Operation Type** - Only processes `payment` operations
2. **Source Account** - Checks if payment originates from bond contract
3. **Asset Filtering** - Optionally filters by specific withdrawal asset

### Bond State Updates

For each withdrawal event:

1. **Retrieve Current Bond** - Gets current bond state from database
2. **Calculate New State** - Computes new amount and active status
3. **Update Database** - Saves updated bond state
4. **Score Snapshot** - Creates score history if needed

### State Calculation Logic

```ts
// Partial withdrawal
previousAmount: '1000.0000000'
withdrawalAmount: '300.0000000'
newAmount: '700.0000000'
isActive: true

// Full withdrawal
previousAmount: '1000.0000000'
withdrawalAmount: '1000.0000000'
newAmount: '0'
isActive: false
```

## Score History Snapshots

Score history snapshots are created for:

- **Full withdrawals** - When bond becomes inactive
- **Large partial withdrawals** - When 50% or more is withdrawn

### Snapshot Structure

```ts
interface ScoreHistorySnapshot {
  address: string
  score: number
  bondedAmount: string
  timestamp: Date
  reason: 'withdrawal_full' | 'withdrawal_partial'
  transactionHash: string
}
```

## Error Handling

The listener implements comprehensive error handling:

### Horizon API Errors

- **Connection failures** - Automatic retry with exponential backoff
- **Rate limiting** - Respects Horizon rate limits
- **Invalid responses** - Logs errors and continues processing

### Database Errors

- **Connection issues** - Logs errors but continues listening
- **Update failures** - Logs detailed error information
- **Missing bonds** - Warns and skips processing

### Graceful Degradation

The listener is designed to continue operating even when:

- Horizon server is temporarily unavailable
- Database connections are intermittent
- Individual events fail to process

## Performance Considerations

### Polling Strategy

- **Configurable intervals** - Adjust based on network activity
- **Batch processing** - Processes multiple events per poll
- **Cursor management** - Efficient resumption without gaps

### Memory Management

- **Event streaming** - Processes events in batches
- **Cursor persistence** - Maintains position across restarts
- **Error cleanup** - Proper resource cleanup on errors

### Database Optimization

- **Batch updates** - Groups multiple bond updates
- **Index usage** - Optimizes queries for bond lookups
- **Transaction safety** - Ensures data consistency

## Monitoring

### Prometheus Metrics

The listeners expose Prometheus metrics for cursor monitoring:

```
# Cursor lag (seconds since last checkpoint)
horizon_listener_cursor_lag_seconds{stream_name="bond_creation"} 5

# Last checkpoint timestamp (Unix timestamp)
horizon_listener_last_checkpoint_timestamp{stream_name="bond_creation"} 1704067200
```

### Grafana Dashboard

Monitor cursor health with these queries:

```promql
# Cursor lag by stream
horizon_listener_cursor_lag_seconds

# Alert if cursor lag exceeds 5 minutes
horizon_listener_cursor_lag_seconds > 300

# Time since last checkpoint
time() - horizon_listener_last_checkpoint_timestamp
```

### Health Checks

Monitor listener health with built-in statistics:

```ts
const stats = listener.getStats()
console.log(`Listener running: ${stats.isRunning}`)
console.log(`Last cursor: ${stats.lastCursor}`)
console.log(`Polling interval: ${stats.pollingInterval}ms`)
```

### Logging

The listener provides detailed logging:

- **Start/stop events** - Listener lifecycle events with cursor position
- **Event processing** - Event ID and cursor after each event
- **Cursor persistence** - Confirmation of cursor saves
- **Errors** - Detailed error information with cursor context
- **Performance** - Processing times and rates

### Metrics to Track

- Events processed per minute
- Cursor lag (seconds)
- Cursor checkpoint frequency
- Bond update success rate
- API error rate
- Processing latency
- Database connection status

## Testing

The listener includes comprehensive tests:

```bash
# Run Horizon listener tests
npm test src/listeners/__tests__

# Run with coverage
npm run test:coverage
```

### Test Coverage

- **Configuration** - Default and custom configurations
- **Lifecycle** - Start/stop operations
- **Event Processing** - Withdrawal detection and processing
- **State Calculations** - Bond state update logic
- **Score Snapshots** - Snapshot creation logic
- **Error Handling** - Various error scenarios

## Security Considerations

### Cursor Validation

The `CursorRepository` validates `paging_token` format before persisting:

- **Numeric tokens** - Must match `/^\d+$/` pattern
- **Special tokens** - Only `'now'` is allowed
- **SQL injection** - Parameterized queries prevent injection
- **Invalid tokens** - Rejected with clear error message

### Network Security

- **HTTPS connections** - Always use HTTPS for Horizon
- **API authentication** - Use authenticated Horizon endpoints
- **Rate limiting** - Respect Horizon rate limits
- **Input validation** - Validate all Horizon responses

### Data Security

- **Sensitive data** - Avoid logging private keys or sensitive data
- **Access control** - Restrict database access
- **Audit logging** - Log all bond state changes
- **Data integrity** - Verify transaction signatures
- **Cursor integrity** - Validate cursor format before persistence

## Best Practices

### Configuration

1. **Environment-specific URLs** - Use testnet for development
2. **Appropriate polling intervals** - Balance responsiveness and efficiency
3. **Proper error handling** - Handle all potential failure modes
4. **Resource limits** - Set reasonable timeouts and retries

### Operations

1. **Monitor health** - Regular health checks and monitoring
2. **Log analysis** - Review logs for errors and patterns
3. **Performance tuning** - Adjust polling based on load
4. **Backup strategies** - Regular database backups

### Development

1. **Test thoroughly** - Cover edge cases and error scenarios
2. **Mock external services** - Use Horizon mocks in tests
3. **Document changes** - Keep documentation updated
4. **Version control** - Track configuration changes

## Troubleshooting

### Common Issues

**Listener not starting**
- Check Horizon URL connectivity
- Verify network passphrase
- Review configuration values
- Check database connectivity for cursor loading

**Missing bond updates**
- Verify bond contract address
- Check database connectivity
- Review withdrawal detection logic
- Check cursor position: `SELECT * FROM horizon_cursors`

**Cursor not advancing**
- Check for event processing errors in logs
- Verify database write permissions
- Review cursor validation errors
- Check for transaction rollbacks

**Events being replayed**
- Cursor may not be persisting (check logs)
- Database transaction may be rolling back
- Verify cursor upsert is called after event processing

**Performance issues**
- Reduce polling interval
- Check database query performance
- Monitor Horizon API usage
- Review cursor persistence overhead

**High error rates**
- Review Horizon API status
- Check network connectivity
- Verify rate limit compliance
- Check cursor validation errors

### Debug Mode

Enable debug logging for troubleshooting:

```ts
// Enable verbose logging
process.env.DEBUG = 'horizon-listener'

// Start listener with debug info
await listener.start()
```

### Cursor Inspection

Inspect cursor state directly:

```sql
-- View all cursors
SELECT * FROM horizon_cursors ORDER BY last_checkpoint DESC;

-- Check specific stream cursor
SELECT * FROM horizon_cursors WHERE stream_name = 'bond_creation';

-- Calculate cursor lag
SELECT 
  stream_name,
  paging_token,
  last_checkpoint,
  EXTRACT(EPOCH FROM (NOW() - last_checkpoint)) AS lag_seconds
FROM horizon_cursors;

-- Reset cursor (use with caution!)
DELETE FROM horizon_cursors WHERE stream_name = 'bond_creation';
```

## Integration Examples

### Basic Integration with Cursor Checkpointing

```ts
import { createHorizonWithdrawalListener } from './listeners/horizonWithdrawalEvents.js'
import { subscribeBondCreationEvents } from './listeners/horizonBondEvents.js'
import { pool } from './db/pool.js'
import { replayService } from './services/replay.js'

async function startListeners() {
  // Start withdrawal listener
  const withdrawalListener = createHorizonWithdrawalListener(
    {
      horizonUrl: process.env.HORIZON_URL!,
      pollingInterval: 5000
    },
    pool,
    replayService
  )

  // Start bond creation listener
  await subscribeBondCreationEvents(pool, (event) => {
    console.log('Bond created:', event)
  })

  // Handle graceful shutdown
  process.on('SIGINT', async () => {
    console.log('Stopping Horizon listeners...')
    await withdrawalListener.stop()
    await pool.end()
    process.exit(0)
  })

  await withdrawalListener.start()
  console.log('Horizon listeners started with cursor checkpointing')
}

startListeners().catch(console.error)
```

### Advanced Configuration with Monitoring

```ts
import { CursorRepository } from './db/repositories/cursorRepository.js'

const cursorRepo = new CursorRepository(pool)

const listener = createHorizonWithdrawalListener(
  {
    horizonUrl: 'https://horizon.stellar.org',
    networkPassphrase: 'Public Global Stellar Network ; September 2015',
    bondContractAddress: 'GABCD...',
    withdrawalAsset: {
      code: 'USDC',
      issuer: 'GA5ZSEJYAAO...Issuer...'
    },
    pollingInterval: 10000
  },
  pool,
  replayService
)

// Monitor listener health and cursor lag
setInterval(async () => {
  const stats = listener.getStats()
  const lag = await cursorRepo.getCursorLag('bond_withdrawal')
  
  console.log('Listener stats:', stats)
  console.log('Cursor lag (seconds):', lag)
  
  // Alert if lag exceeds threshold
  if (lag && lag > 300) {
    console.error('WARNING: Cursor lag exceeds 5 minutes!')
  }
}, 60000)
```

### Manual Cursor Management

```ts
// Reset cursor to specific position (e.g., after data recovery)
await cursorRepo.upsert({
  streamName: 'bond_creation',
  pagingToken: '12345678901234'
})

// Delete cursor to restart from 'now' (use with caution!)
await cursorRepo.delete('bond_creation')

// View all cursors
const allCursors = await cursorRepo.findAll()
console.log('All cursors:', allCursors)
```

## Migration

To enable cursor checkpointing on an existing deployment:

1. **Run Migration** - Apply migration `007_create_horizon_cursors.ts`
2. **Deploy Updated Code** - Deploy listeners with cursor support
3. **First Boot** - Listeners will start from `'now'` (no saved cursor)
4. **Subsequent Restarts** - Listeners resume from saved cursor

```bash
# Run migration
npm run migrate

# Deploy updated code
npm run build
npm start
```

This Horizon listener provides a robust foundation for maintaining bond state consistency with the Stellar blockchain while ensuring high availability, error resilience, and gap-free event processing through durable cursor checkpointing.
# Horizon Bond Creation Listener

This module listens for bond creation events from Stellar/Horizon and syncs identity and bond state to the database.

## Features
- Subscribes to Horizon for bond creation events
- Parses event payload (identity, amount, duration, etc.)
- Upserts identity and bond records in PostgreSQL
- Handles reconnection and backfill
- Comprehensive tests with mocked Horizon

## Usage

```typescript
import { subscribeBondCreationEvents } from '../src/listeners/horizonBondEvents';

subscribeBondCreationEvents((event) => {
  // Handle bond creation event
  console.log(event);
});
```

## Event Payload Example
```
{
  identity: {
    id: 'GABC...',
    // ...other fields
  },
  bond: {
    id: 'bond123',
    amount: '1000',
    duration: '365',
    // ...other fields
  }
}
```

## Testing
- Tests are located in `src/__tests__/horizonBondEvents.test.ts`
- Run tests with `npm test` or `npx jest`
- Mocked Horizon stream covers event parsing, DB upsert, duplicate handling

## JSDoc
- All functions are documented with JSDoc comments in `src/listeners/horizonBondEvents.ts`

## Requirements
 - Minimum 95% test coverage
 - Clear documentation

## Backfill & Reconnection
 - Listener automatically reconnects on errors
 - Backfill logic can be extended to fetch missed events

## Event Validation
The bond creation listener now includes comprehensive validation of incoming Horizon operations to prevent processing malformed or unexpected payloads:

### Validation Features
- **Stellar Account Validation**: Ensures `source_account` is a valid Stellar account ID using StrKey validation
- **Amount Validation**: Verifies `amount` is a non-negative integer string
- **Operation ID**: Ensures `id` is present and non-empty
- **Duration Validation**: Accepts string or null values for `duration`
- **Schema Validation**: Uses Zod schemas for robust validation of all required fields

### Error Handling
When validation fails:
- The malformed operation is sent to the `failed_inbound_events` table for inspection
- The cursor is **not** advanced, allowing for manual inspection and potential reprocessing
- Processing continues with the next operation in the stream

### Validation Failure Examples
Operations that will be quarantined:
- Missing `source_account` field
- Invalid Stellar account ID in `source_account`
- Missing `amount` field
- Non-numeric or negative `amount` values
- Missing `operation ID`

---
For further details, see the code and tests.
