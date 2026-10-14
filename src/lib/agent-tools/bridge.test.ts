import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import { serveStdio, StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { createTallyMcpServer, bridgeConfiguration } from "./bridge.ts";
import { handleAgentRequest } from "./http.server.ts";
import { AgentToolService } from "./service.ts";
import { MemoryWorkspaceStore } from "./store.ts";
import { syntheticEnvironment, SYNTHETIC_AGENT_TOKEN } from "./test-fixtures.ts";
test("official MCP SDK stdio performs discovery and a real tool call against synthetic REST", async () => {
  const environment = {
    ...syntheticEnvironment(),
    TALLY_URL: "http://127.0.0.1:8080/finance/",
    TALLY_ACCESS_TOKEN: SYNTHETIC_AGENT_TOKEN,
  };
  const service = new AgentToolService(new MemoryWorkspaceStore());
  const fetcher: typeof fetch = async (url, init) =>
    handleAgentRequest(new Request(String(url), init), service, environment);
  const server = await createTallyMcpServer(environment, fetcher);
  const input = new PassThrough();
  const output = new PassThrough();
  let buffer = "";
  const responses = new Map<number, any>();
  output.on("data", (chunk) => {
    buffer += chunk.toString();
    let end: number;
    while ((end = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      const message = JSON.parse(line);
      if (message.id) responses.set(message.id, message);
    }
  });
  const transport = new StdioServerTransport(input, output);
  const handle = serveStdio(() => server, { transport });
  const send = async (id: number, method: string, params: Record<string, unknown>) => {
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    for (let n = 0; n < 100 && !responses.has(id); n++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(responses.has(id), `MCP response ${id} missing`);
    const value = responses.get(id);
    assert.equal(value.error, undefined, JSON.stringify(value));
    return value.result;
  };
  try {
    await send(1, "initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "synthetic-test", version: "1" },
    });
    input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    const list = await send(2, "tools/list", {});
    assert.equal(list.tools.length, 79);
    assert.ok(
      list.tools
        .find((t: any) => t.name === "tally_create_category")
        .inputSchema.required.includes("idempotencyKey"),
    );
    const result = await send(3, "tools/call", {
      name: "tally_get_ledger",
      arguments: { currency: "INR" },
    });
    assert.equal(result.structuredContent.result.revision, 0);
    const mutation = await send(4, "tools/call", {
      name: "tally_create_category",
      arguments: {
        currency: "INR",
        expectedRevision: 0,
        name: "Synthetic MCP category",
        kind: "expense",
        idempotencyKey: "synthetic-mcp-once",
      },
    });
    assert.equal(mutation.structuredContent.result.revision, 1);
    const replay = await send(5, "tools/call", {
      name: "tally_create_category",
      arguments: {
        currency: "INR",
        expectedRevision: 0,
        name: "Synthetic MCP category",
        kind: "expense",
        idempotencyKey: "synthetic-mcp-once",
      },
    });
    assert.equal(replay.structuredContent.replayed, true);
  } finally {
    await handle.close();
    input.destroy();
    output.destroy();
  }
});
test("bridge refuses insecure remote URLs, embedded credentials and short tokens", () => {
  for (const url of [
    "http://remote.invalid/finance/",
    "https://user:password@remote.invalid/finance/",
    "https://remote.invalid/?token=bad",
  ])
    assert.throws(() =>
      bridgeConfiguration({ TALLY_URL: url, TALLY_ACCESS_TOKEN: SYNTHETIC_AGENT_TOKEN }),
    );
  assert.throws(() =>
    bridgeConfiguration({ TALLY_URL: "https://hub.invalid/finance/", TALLY_ACCESS_TOKEN: "short" }),
  );
});
