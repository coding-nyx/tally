import { Pool } from "pg";
import { isDeepStrictEqual } from "node:util";
import { emptyWorkspace, type Workspace, type WorkspaceStore } from "./store.ts";
import { hydrateStatements, persistStatements } from "./statements-store.server.ts";
import type { Account, JournalEvent, Posting } from "../accounting.ts";

/** One owner document per row. FOR UPDATE serializes UI/REST/MCP and receipts. No runtime DDL. */
export class PostgresWorkspaceStore implements WorkspaceStore {
  private pool: Pool;
  private statementsEnabled: boolean;
  constructor(pool: Pool, statementsEnabled = false) {
    this.statementsEnabled = statementsEnabled;
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
      const accounts = await client.query<{ currency: "INR" | "USD"; document: Account }>(
        "SELECT currency,document FROM tally_financial_accounts WHERE owner_id=$1 ORDER BY id",
        [ownerId],
      );
      const events = await client.query<{ currency: "INR" | "USD"; document: JournalEvent }>(
        "SELECT currency,document FROM tally_journal_events WHERE owner_id=$1 ORDER BY effective_date,id",
        [ownerId],
      );
      const postings = await client.query<{
        event_id: string;
        financial_account_id: string | null;
        role: Posting["role"];
        category_id: string | null;
        side: Posting["side"];
        amount_minor: string;
        component: Posting["component"];
      }>(
        "SELECT event_id,financial_account_id,role,category_id,component,side,amount_minor FROM tally_journal_postings WHERE owner_id=$1 ORDER BY event_id,ordinal",
        [ownerId],
      );
      const byId = new Map(
        events.rows.map((r) => [r.document.id, { ...r.document, postings: [] as Posting[] }]),
      );
      for (const row of postings.rows) {
        const event = byId.get(row.event_id);
        if (!event) throw new Error("Orphan journal posting");
        event.postings.push({
          side: row.side,
          amountMinor: Number(row.amount_minor),
          ...(row.financial_account_id ? { accountId: row.financial_account_id } : {}),
          ...(row.role ? { role: row.role } : {}),
          ...(row.category_id ? { categoryId: row.category_id } : {}),
          ...(row.component ? { component: row.component } : {}),
        });
      }
      for (const currency of ["INR", "USD"] as const)
        state.ledgers[currency].accounting = {
          accounts: accounts.rows.filter((r) => r.currency === currency).map((r) => r.document),
          events: [...byId.values()].filter((e) => e.currency === currency),
        };
      const priorStatements = this.statementsEnabled
        ? await hydrateStatements(client, ownerId, state)
        : undefined;
      const priorAccounts = new Map(
        accounts.rows.map((r) => [r.document.id, JSON.stringify(r.document)]),
      );
      const priorEvents = new Map([...byId].map(([id, event]) => [id, JSON.stringify(event)]));
      const result = await work(state);
      for (const currency of ["INR", "USD"] as const) {
        const accounting = state.ledgers[currency].accounting!;
        for (const account of accounting.accounts) {
          const encoded = JSON.stringify(account);
          if (priorAccounts.get(account.id) === encoded) continue;
          await client.query(
            `INSERT INTO tally_financial_accounts(owner_id,currency,id,account_type,document)
            VALUES($1,$2,$3,$4,$5) ON CONFLICT(owner_id,currency,id) DO UPDATE SET document=excluded.document`,
            [ownerId, currency, account.id, account.type, encoded],
          );
        }
        for (const event of accounting.events) {
          if (priorEvents.has(event.id)) {
            if (!isDeepStrictEqual(JSON.parse(priorEvents.get(event.id)!), event))
              throw new Error("Posted journals are immutable");
            continue;
          }
          const { postings: eventPostings, ...metadata } = event;
          await client.query(
            `INSERT INTO tally_journal_events(owner_id,currency,id,effective_date,event_kind,related_event_id,document)
            VALUES($1,$2,$3,$4,$5,$6,$7)`,
            [
              ownerId,
              currency,
              event.id,
              event.date,
              event.kind,
              event.relatedEventId ?? null,
              JSON.stringify(metadata),
            ],
          );
          for (const [index, posting] of eventPostings.entries())
            await client.query(
              `INSERT INTO tally_journal_postings(owner_id,currency,event_id,ordinal,financial_account_id,role,category_id,side,amount_minor,component)
              VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
              [
                ownerId,
                currency,
                event.id,
                index,
                posting.accountId ?? null,
                posting.role ?? null,
                posting.categoryId ?? null,
                posting.side,
                posting.amountMinor,
                posting.component ?? null,
              ],
            );
        }
      }
      const retainedAccountIds = new Set(
        ["INR", "USD"].flatMap((currency) =>
          state.ledgers[currency as "INR" | "USD"].accounting!.accounts.map((a) => a.id),
        ),
      );
      const retainedEventIds = new Set(
        ["INR", "USD"].flatMap((currency) =>
          state.ledgers[currency as "INR" | "USD"].accounting!.events.map((e) => e.id),
        ),
      );
      if (
        [...priorAccounts.keys()].some((id) => !retainedAccountIds.has(id)) ||
        [...priorEvents.keys()].some((id) => !retainedEventIds.has(id))
      )
        throw new Error("Financial history cannot be deleted");
      if (priorStatements) await persistStatements(client, ownerId, state, priorStatements);
      // SQL rows are authoritative; the legacy document holds configuration,
      // receipts and bounded previews, never a second live copy of journals.
      const persisted = structuredClone(state);
      delete persisted.ledgers.INR.accounting;
      delete persisted.ledgers.USD.accounting;
      delete persisted.ledgers.INR.statements;
      delete persisted.ledgers.USD.statements;
      const document = JSON.stringify(persisted);
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
    environment.TALLY_STATEMENTS_ENABLED === "true",
  );
  return store;
}
