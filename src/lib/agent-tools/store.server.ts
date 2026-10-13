import { Pool } from "pg";
import { emptyWorkspace, type Workspace, type WorkspaceStore } from "./store.ts";

/** One owner document per row. FOR UPDATE serializes UI/REST/MCP and receipts. No runtime DDL. */
export class PostgresWorkspaceStore implements WorkspaceStore {
  private pool: Pool;
  constructor(pool: Pool) {
    this.pool = pool;
  }
  async transaction<T>(ownerId: string, work: (workspace: Workspace) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL statement_timeout = '15s'");
      await client.query(
        "INSERT INTO tally_agent_workspaces(owner_id,document) VALUES($1,$2) ON CONFLICT(owner_id) DO NOTHING",
        [ownerId, JSON.stringify(emptyWorkspace())],
      );
      const rows = await client.query<{ document: Workspace }>(
        "SELECT document FROM tally_agent_workspaces WHERE owner_id=$1 FOR UPDATE",
        [ownerId],
      );
      const state = rows.rows[0]?.document;
      if (!state || state.version !== 2) throw new Error("Unsupported workspace version");
      const result = await work(state);
      const document = JSON.stringify(state);
      if (Buffer.byteLength(document) > 128 * 1024 * 1024)
        throw new Error("Workspace storage quota exceeded; remove expired drafts before retrying");
      await client.query(
        "UPDATE tally_agent_workspaces SET document=$2,updated_at=now() WHERE owner_id=$1",
        [ownerId, document],
      );
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
let store: PostgresWorkspaceStore | undefined;
export function configuredStore(environment = process.env): PostgresWorkspaceStore {
  if (environment.TALLY_AGENT_ENABLED !== "true" || !environment.TALLY_AGENT_DATABASE_URL?.trim())
    throw new Error("Agent tools are not configured");
  store ??= new PostgresWorkspaceStore(
    new Pool({
      connectionString: environment.TALLY_AGENT_DATABASE_URL,
      max: 4,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 30000,
    }),
  );
  return store;
}
