import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createTallyMcpServer } from "../src/lib/agent-tools/bridge.ts";
// stdout belongs exclusively to MCP. Failures never print credentials or request payloads.
try {
  const server = await createTallyMcpServer();
  serveStdio(() => server, { onerror: () => console.error("Tally MCP transport error.") });
} catch {
  console.error(
    "Tally MCP could not start. Check private service URL and scoped credential setup.",
  );
  process.exitCode = 1;
}
