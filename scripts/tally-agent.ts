import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { bridgeConfiguration } from "../src/lib/agent-tools/bridge.ts";
const [command, ...args] = process.argv.slice(2);
try {
  const config = bridgeConfiguration(process.env);
  let path = "api/agent";
  let init: RequestInit = { headers: {} };
  if (command === "upload") {
    const [currency, file] = args;
    if (!["INR", "USD"].includes(currency) || !file)
      throw new Error("Use upload INR|USD <explicit-file-path>.");
    const data = await readFile(file);
    if (!data.length || data.length > 10485760)
      throw new Error("Choose a nonempty file under 10 MB.");
    const extension = file.split(".").at(-1)?.toLowerCase();
    const mime =
      extension === "csv"
        ? "text/csv"
        : extension === "pdf"
          ? "application/pdf"
          : extension === "json"
            ? "application/json"
            : "text/plain";
    path = `api/agent/files?currency=${currency}`;
    init = {
      method: "POST",
      headers: {
        "content-type": mime,
        "x-file-name": basename(file).replace(/[^a-zA-Z0-9._-]/g, "_"),
      },
      body: data,
    };
  } else if (command === "call") {
    const body = args.join(" ");
    JSON.parse(body);
    if (Buffer.byteLength(body) > 16384) throw new Error("Control request exceeds 16 KB.");
    init = { method: "POST", headers: { "content-type": "application/json" }, body };
  } else if (command !== "discover")
    throw new Error("Use discover, call <JSON>, or upload <currency> <explicit-file-path>.");
  const response = await fetch(new URL(path, config.base), {
    ...init,
    redirect: "error",
    signal: AbortSignal.timeout(20000),
    headers: { ...init.headers, authorization: `Bearer ${config.token}` },
  });
  if (!response.ok) {
    const error = (await response.json()) as { error?: { code?: string; message?: string } };
    console.error(
      `${error.error?.code ?? "unavailable"}: ${error.error?.message ?? "Request failed."}`,
    );
    process.exitCode = 1;
  } else console.log(JSON.stringify(await response.json(), null, 2));
} catch (e) {
  console.error(
    e instanceof Error && !/url|fetch|connect/i.test(e.message)
      ? e.message
      : "Tally CLI could not connect. Check protected credential and service configuration.",
  );
  process.exitCode = 1;
}
