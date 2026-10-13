import { writeFile } from "node:fs/promises";
import { z } from "zod";
import { catalog } from "../src/lib/agent-tools/catalog.ts";
const tools = Object.entries(catalog).map(([name, definition]) => ({
  name,
  description: definition.description,
  scope: definition.scope,
  effect: definition.effect,
  inputSchema: z.toJSONSchema(definition.schema, { unrepresentable: "any" }),
  ...(definition.effect !== "read" ? { idempotencyKeyRequired: true } : {}),
}));
const destination = new URL("../skills/tally/references/tools.json", import.meta.url);
await writeFile(destination, `${JSON.stringify({ version: 2, tools }, null, 2)}\n`);
console.log(`Generated ${tools.length} Tally tool contracts.`);
