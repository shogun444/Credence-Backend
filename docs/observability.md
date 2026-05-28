# Observability: Request Tracing & Metrics

To facilitate debugging in our distributed environment, every request is assigned a `Request ID` and a `Correlation ID`.

- **X-Request-ID**: Unique to every single HTTP call to this service.
- **X-Correlation-ID**: Persists across services. If an upstream service sends one, we propagate it.

## Log Format
All logs emitted during a request lifecycle include these IDs automatically:
`[INFO] [RequestID: <uuid>] [CorrelationID: <uuid>] - <message>`

## Outbox Publisher Observability (Issue #329)

The outbox publisher now emits structured logs via `src/utils/logger.ts` instead of `console.*`, allowing aggregation with our centralized logging.

It also exports the following Prometheus metrics to track throughput, lag, and failure rates:
- **`outbox_published_total`** (Counter): Total number of successfully published outbox events, labeled by `aggregate_type`.
- **`outbox_failed_total`** (Counter): Total number of failed outbox event publish attempts, labeled by `aggregate_type`.
- **`outbox_pending_gauge`** (Gauge): Current number of pending outbox events (lag/backlog).
- **`outbox_lease_renew_total`** (Counter): Total number of outbox events whose lease was renewed, indicating processing duration or stalls.
- **`outbox_dead_letter_total`** (Counter): Total number of outbox events moved to dead-letter, labeled by `error_code`.