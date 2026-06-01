/**
 * Horizon Bond Creation Listener
 * Single stream with bounded exponential-backoff-with-jitter reconnect.
 * @module horizonBondEvents
 */

import { Horizon } from '@stellar/stellar-sdk'
import { upsertIdentity, upsertBond } from '../services/identityService.js'
import { CursorRepository } from '../db/repositories/cursorRepository.js'
import { pool } from '../db/pool.js'
import { register, Gauge } from 'prom-client'

const HORIZON_URL = process.env.HORIZON_URL || "https://horizon.stellar.org";
const server = new Horizon.Server(HORIZON_URL);
const STREAM_NAME = "bond_creation";

const cursorLagGauge = new Gauge({
  name: "horizon_listener_cursor_lag_seconds",
  help: "Time elapsed since last Horizon cursor checkpoint",
  labelNames: ["stream_name"],
  registers: [register],
});

const lastCheckpointGauge = new Gauge({
  name: "horizon_listener_last_checkpoint_timestamp",
  help: "Unix timestamp of last Horizon cursor checkpoint",
  labelNames: ["stream_name"],
  registers: [register],
});

/**
 * Subscribe to bond creation events from Horizon with durable cursor checkpointing
 * @param {Pool} pool PostgreSQL connection pool for cursor persistence
 * @param {function} onEvent Callback for each bond creation event
 */
export function subscribeBondCreationEvents(replayService: {
  captureFailure: (type: string, data: any, reason: string) => Promise<unknown>
}, onEvent?: (event: { identity: { id: string }; bond: { id: string; address: string; amount: string; duration: string | null } }) => void) {
  // Example: Listen to operations of type 'create_bond' (custom event)
  let cursor = 'now';
  let stream;
  const cursorRepo = new CursorRepository(pool)
  const startStream = () => {
    stream = (server.operations() as any)
      .forAsset('BOND') // Replace with actual asset code if needed
      .cursor(cursor)
      .stream({
        onmessage: async (op: any) => {
          const newCursor = op.paging_token
          
          try {
            if (op.type === 'create_bond') {
              const event = parseBondEvent(op)
              
              // Apply event to database
              await upsertIdentity(event.identity)
              await upsertBond(event.bond)
              
              // Persist cursor transactionally after successful event processing
              await cursorRepo.upsert({
                streamName: STREAM_NAME,
                pagingToken: newCursor
              })
              
              // Update cursor only after successful persistence
              cursor = newCursor
              
              // Update metrics
              updateMetrics(cursorRepo)
              
              if (onEvent) onEvent(event)
              
              console.log(`[${STREAM_NAME}] Processed event ${op.id}, cursor: ${newCursor}`)
            }
          } catch (err) {
            console.error(`[${STREAM_NAME}] Error processing event ${op.id}:`, err)
            // Do NOT advance cursor on failure - event will be retried on reconnect
            throw err
          }
        },
        onerror: (err: unknown) => {
          console.error(`[${STREAM_NAME}] Horizon stream error:`, err)
          setTimeout(() => {
            startStream() // Reconnect after delay, resuming from last successful cursor
          }, 5000)
        }
      });
  };
  startStream();
}

/**
 * Subscribe to bond creation events from Horizon.
 * Opens exactly ONE stream. On error, reconnects with bounded
 * exponential-backoff-with-jitter (default: 500 ms base, 30 s cap).
 */
export function subscribeBondCreationEvents(
  replayService: {
    captureFailure: (type: string, data: any, reason: string) => Promise<unknown>;
  },
  onEvent?: (event: {
    identity: { id: string };
    bond: { id: string; address: string; amount: string; duration: string | null };
  }) => void,
  pool?: Pool
): BondCreationHandle {
  const cursorRepo = pool ? new CursorRepository(pool) : undefined;
  const backoff = new BoundedBackoff({ baseMs: 500, maxMs: 30_000 });
  const metrics = getHorizonMetrics();
  let cursor = "now";
  let activeStream: { close?: () => void } | undefined;
  let stopped = false;

  const startStream = () => {
    if (stopped) return;

    metrics.streamUp.set({ stream: STREAM_NAME }, 1);

    activeStream = (server.operations() as any)
      .forAsset("BOND")
      .cursor(cursor)
      .stream({
        onmessage: async (op: any) => {
          const newCursor = op.paging_token;
          try {
            if (op.type === "create_bond") {
              const event = parseBondEvent(op);
              await upsertIdentity(event.identity);
              await upsertBond(event.bond);
              if (cursorRepo) {
                await cursorRepo.upsert({ streamName: STREAM_NAME, pagingToken: newCursor });
              }
              cursor = newCursor;
              if (cursorRepo) updateMetrics(cursorRepo);
              if (onEvent) onEvent(event);
              backoff.reset();
              console.log(`[${STREAM_NAME}] Processed event ${op.id}, cursor: ${newCursor}`);
            }
          } catch (err) {
            console.error(`[${STREAM_NAME}] Error processing event ${op.id}:`, err);
            throw err;
          }
        },
        onerror: async (err: unknown) => {
          console.error(`[${STREAM_NAME}] Horizon stream error:`, err);
          metrics.streamUp.set({ stream: STREAM_NAME }, 0);
          if (stopped) return;
          metrics.reconnectTotal.inc({ stream: STREAM_NAME });
          try {
            await backoff.wait();
            startStream();
          } catch (e: any) {
            if (e?.stopped || e?.exhausted) {
              console.warn(`[${STREAM_NAME}] Reconnect aborted:`, e);
            }
          }
        },
      });
  };

  // Start exactly ONE stream
  startStream();

  return {
    stop: () => {
      stopped = true;
      backoff.stop();
      metrics.streamUp.set({ stream: STREAM_NAME }, 0);
      if (activeStream?.close) activeStream.close();
    },
  };
}

async function updateMetrics(cursorRepo: CursorRepository) {
  try {
    const lag = await cursorRepo.getCursorLag(STREAM_NAME);
    if (lag !== null) cursorLagGauge.set({ stream_name: STREAM_NAME }, lag);
    const cursor = await cursorRepo.findByStreamName(STREAM_NAME);
    if (cursor) {
      lastCheckpointGauge.set(
        { stream_name: STREAM_NAME },
        Math.floor(cursor.lastCheckpoint.getTime() / 1000)
      );
    }
  } catch (err) {
    console.error(`[${STREAM_NAME}] Error updating metrics:`, err);
  }
}

function parseBondEvent(op: {
  source_account: string;
  id: string;
  amount: string;
  duration?: string | null;
}) {
  return {
    identity: { id: op.source_account },
    bond: {
      id: op.id,
      address: op.source_account,
      amount: op.amount,
      duration: op.duration ?? null,
    },
  };
}
