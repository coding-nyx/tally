import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import pg from "pg";
// Deliberate release action; never invoked by a build or web request.
let pool, client;
try {
  if (process.env.TALLY_AGENT_ENABLED !== "true") throw new Error("Migration disabled");
  const connectionString = process.env.TALLY_AGENT_DATABASE_URL_FILE
    ? (await readFile(process.env.TALLY_AGENT_DATABASE_URL_FILE, "utf8")).trim()
    : process.env.TALLY_AGENT_DATABASE_URL;
  if (!connectionString) throw new Error("Missing migration connection");
  pool = new pg.Pool({ connectionString, max: 1 });
  client = await pool.connect();
  const folder = new URL("../migrations/agent-tools/", import.meta.url);
  await client.query("BEGIN");
  await client.query("SELECT pg_advisory_xact_lock(7310042)");
  await client.query(
    "CREATE TABLE IF NOT EXISTS tally_schema_migrations(version text PRIMARY KEY,sha256 text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())",
  );
  for (const version of (await readdir(folder))
    .filter((s) => /^\d{4}_[a-z0-9_-]+\.sql$/.test(s))
    .sort()) {
    const sql = await readFile(new URL(version, folder), "utf8");
    const sha = createHash("sha256").update(sql).digest("hex");
    const prior = await client.query(
      "SELECT sha256 FROM tally_schema_migrations WHERE version=$1",
      [version],
    );
    if (prior.rows.length) {
      if (prior.rows[0].sha256 !== sha) throw new Error("An applied migration changed");
      continue;
    }
    await client.query(sql);
    await client.query("INSERT INTO tally_schema_migrations(version,sha256) VALUES($1,$2)", [
      version,
      sha,
    ]);
  }
  await client.query("COMMIT");
  console.log("Tally schema migrations applied. No financial records were imported.");
} catch {
  if (client) await client.query("ROLLBACK").catch(() => undefined);
  console.error(
    "Tally migration failed. Inspect protected database configuration and migration checksums privately.",
  );
  process.exitCode = 1;
} finally {
  client?.release();
  if (pool) await pool.end();
}
