import type { PoolClient } from "pg";
import { isDeepStrictEqual } from "node:util";
import { digest, emptyStatements, type StatementLedger } from "../statements.ts";
import type { Workspace } from "./store.ts";
const specs: Array<{
  key: Exclude<keyof StatementLedger, "files">;
  table: string;
  refs: Array<[string, string]>;
}> = [
  {
    key: "statements",
    table: "tally_statements",
    refs: [
      ["account_id", "accountId"],
      ["source_file_id", "sourceFileId"],
      ["previous_id", "previousId"],
    ],
  },
  {
    key: "observations",
    table: "tally_statement_observations",
    refs: [
      ["account_id", "accountId"],
      ["statement_id", "statementId"],
      ["source_identity", "sourceIdentity"],
    ],
  },
  {
    key: "decisions",
    table: "tally_event_sources",
    refs: [
      ["account_id", "accountId"],
      ["observation_id", "observationId"],
      ["event_id", "eventId"],
    ],
  },
  {
    key: "reconciliations",
    table: "tally_reconciliations",
    refs: [
      ["account_id", "accountId"],
      ["statement_id", "statementId"],
    ],
  },
  {
    key: "migrations",
    table: "tally_migration_batches",
    refs: [["source_file_id", "sourceFileId"]],
  },
  {
    key: "legacyDecisions",
    table: "tally_legacy_decisions",
    refs: [
      ["batch_id", "batchId"],
      ["legacy_id", "legacyId"],
      ["previous_id", "previousId"],
      ["account_id", "accountId"],
      ["event_id", "eventId"],
    ],
  },
];
/** Static table names only. Rows/blobs are append-only; receipts commit in the parent transaction. */
export async function hydrateStatements(client: PoolClient, ownerId: string, state: Workspace) {
  for (const c of ["INR", "USD"] as const) state.ledgers[c].statements = emptyStatements();
  const files = await client.query(
    "SELECT currency,id,sha256,mime,name,bytes,created_at FROM tally_source_files WHERE owner_id=$1 ORDER BY created_at,id",
    [ownerId],
  );
  for (const f of files.rows) {
    if (digest(f.bytes) !== f.sha256) throw new Error("Persistent source digest mismatch");
    state.ledgers[f.currency as "INR" | "USD"].statements!.files.push({
      id: f.id,
      currency: f.currency,
      sha256: f.sha256,
      mime: f.mime,
      name: f.name,
      bytes: Buffer.from(f.bytes).toString("base64"),
      createdAt: Number(f.created_at),
    });
  }
  for (const spec of specs) {
    const rows = await client.query(
      `SELECT currency,document FROM ${spec.table} WHERE owner_id=$1 ORDER BY ctid`,
      [ownerId],
    );
    for (const row of rows.rows)
      (state.ledgers[row.currency as "INR" | "USD"].statements![spec.key] as any[]).push(
        row.document,
      );
  }
  return structuredClone({
    INR: state.ledgers.INR.statements!,
    USD: state.ledgers.USD.statements!,
  });
}
export async function persistStatements(
  client: PoolClient,
  ownerId: string,
  state: Workspace,
  prior: Record<"INR" | "USD", StatementLedger>,
) {
  for (const currency of ["INR", "USD"] as const) {
    const next = state.ledgers[currency].statements!;
    if (Buffer.byteLength(JSON.stringify(next)) > 128 * 1024 * 1024)
      throw new Error("Persistent evidence document quota exceeded");
    for (const key of Object.keys(prior[currency]) as Array<keyof StatementLedger>) {
      const old = new Map(prior[currency][key].map((r) => [r.id, r]));
      if (new Set(next[key].map((r) => r.id)).size !== next[key].length)
        throw new Error("Duplicate source record id");
      for (const row of old.values())
        if (!next[key].some((r) => r.id === row.id && isDeepStrictEqual(row, r)))
          throw new Error("Persistent source history is immutable");
    }
    const oldFiles = new Set(prior[currency].files.map((f) => f.id));
    for (const file of next.files.filter((f) => !oldFiles.has(f.id))) {
      const bytes = Buffer.from(file.bytes, "base64");
      if (digest(bytes) !== file.sha256) throw new Error("Source digest mismatch");
      await client.query(
        "INSERT INTO tally_source_files(owner_id,currency,id,sha256,mime,name,bytes,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
        [ownerId, currency, file.id, file.sha256, file.mime, file.name, bytes, file.createdAt],
      );
    }
    for (const spec of specs) {
      const old = new Set(prior[currency][spec.key].map((r) => r.id));
      for (const row of next[spec.key].filter((r) => !old.has(r.id))) {
        const columns = [
          "owner_id",
          "currency",
          "id",
          ...spec.refs.map(([column]) => column),
          "document",
        ];
        const values = [
          ownerId,
          currency,
          row.id,
          ...spec.refs.map(([, property]) => (row as any)[property] ?? null),
          JSON.stringify(row),
        ];
        await client.query(
          `INSERT INTO ${spec.table}(${columns.join(",")}) VALUES(${values.map((_, i) => `$${i + 1}`).join(",")})`,
          values,
        );
      }
    }
  }
}
