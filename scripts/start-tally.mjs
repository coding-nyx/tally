import { readFile } from "node:fs/promises";
import { pathToFileURL, fileURLToPath } from "node:url";
import { resolve } from "node:path";

export async function runtimeSecrets(environment, read = readFile) {
  const result = { ...environment };
  for (const key of ["TALLY_AGENT_DATABASE_URL", "TALLY_AGENT_GRANTS_JSON", "TALLY_AI_API_KEY"]) {
    const file = environment[`${key}_FILE`];
    if (!file) continue;
    if (environment[key])
      throw new Error("Configure each secret using either its value or its file, never both.");
    let value;
    try {
      value = await read(file, "utf8");
    } catch {
      throw new Error("A protected runtime secret file could not be read.");
    }
    if (!value.trim() || Buffer.byteLength(value) > 1048576)
      throw new Error("A protected runtime secret file is empty or oversized.");
    result[key] = value.trim();
  }
  return result;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    Object.assign(process.env, await runtimeSecrets(process.env));
    await import(pathToFileURL(resolve("server/index.mjs")).href);
  } catch {
    console.error(
      "Tally could not start. Inspect protected runtime configuration and server availability privately.",
    );
    process.exitCode = 1;
  }
}
