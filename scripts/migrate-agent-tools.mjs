import { readFile } from "node:fs/promises";
import pg from "pg";
// Deliberate release action; never part of build or request startup.
if (process.env.TALLY_AGENT_ENABLED !== "true" || !process.env.TALLY_AGENT_DATABASE_URL) {
  console.error(
    "Agent migration requires explicit TALLY_AGENT_ENABLED=true and protected TALLY_AGENT_DATABASE_URL.",
  );
  process.exitCode = 1;
} else {
  const pool = new pg.Pool({ connectionString: process.env.TALLY_AGENT_DATABASE_URL, max: 1 });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(7310042)");
    await client.query(
      await readFile(
        new URL("../migrations/agent-tools/0001_workspace.sql", import.meta.url),
        "utf8",
      ),
    );
    await client.query("COMMIT");
    console.log("Tally agent schema is ready. No ledger data was imported.");
  } catch {
    await client.query("ROLLBACK").catch(() => undefined);
    console.error(
      "Agent migration failed. Inspect database availability and release permissions privately.",
    );
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}
