// Repository for request snapshots
import { PoolClient } from 'pg';
import { sql } from 'slonik';

export class RequestSnapshotsRepository {
  constructor(private readonly client: PoolClient) {}

  async create(params: {
    requestId: string;
    method: string;
    path: string;
    headers: Record<string, string>;
    body: any;
    snapshot: any;
  }): Promise<void> {
    const { requestId, method, path, headers, body, snapshot } = params;
    await this.client.query(
      sql`
        INSERT INTO request_snapshots (request_id, method, path, headers, body, snapshot)
        VALUES (${requestId}, ${method}, ${path}, ${JSON.stringify(headers)}::jsonb, ${JSON.stringify(body)}::jsonb, ${JSON.stringify(snapshot)}::jsonb)
        ON CONFLICT (request_id) DO UPDATE SET method = EXCLUDED.method, path = EXCLUDED.path, headers = EXCLUDED.headers, body = EXCLUDED.body, snapshot = EXCLUDED.snapshot;
      `
    );
  }

  async findById(requestId: string): Promise<any | null> {
    const { rows } = await this.client.query(
      sql`
        SELECT * FROM request_snapshots WHERE request_id = ${requestId}
      `
    );
    return rows[0] ?? null;
  }

  // Cleanup old snapshots (TTL 14 days)
  async deleteOlderThan(days: number = 14): Promise<void> {
    await this.client.query(
      sql`
        DELETE FROM request_snapshots WHERE created_at < now() - interval '${days} days'
      `
    );
  }
}
