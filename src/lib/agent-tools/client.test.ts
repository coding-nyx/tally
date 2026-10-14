import assert from "node:assert/strict";
import test from "node:test";
import { agentBaseUrl, TallyClient, TallyClientError } from "./client.ts";
import { handleAgentRequest } from "./http.server.ts";
import { AgentToolService } from "./service.ts";
import { MemoryWorkspaceStore } from "./store.ts";
import { syntheticEnvironment, SYNTHETIC_AGENT_TOKEN } from "./test-fixtures.ts";

test("workspace discovery uses the private prefix and no credential or AI call", async (t) => {
  const endpoint = agentBaseUrl({
    origin: "https://hub.test.ts.net",
    pathname: "/finance/agents/",
  });
  const env = {
    ...syntheticEnvironment("https://hub.test.ts.net"),
    TALLY_AGENT_AUTH_MODE: "tailnet",
    TALLY_AGENT_WORKSPACE_ID: "synthetic-workspace",
    TALLY_AGENT_TRUSTED_PROXY_IPS: "172.20.0.1",
    TALLY_STATEMENTS_ENABLED: "true",
  };
  let requests = 0;
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    requests += 1;
    assert.equal(url, "https://hub.test.ts.net/finance/api/agent");
    assert.equal(init.redirect, "error");
    const request = new Request(url, init);
    assert.equal(request.method, "GET");
    assert.equal(request.headers.has("authorization"), false);
    assert.equal(request.headers.get("x-tally-request"), "1");
    request.headers.set("origin", "https://hub.test.ts.net");
    request.headers.set("sec-fetch-site", "same-origin");
    request.headers.set("x-forwarded-for", "100.64.0.2, 127.0.0.1");
    request.headers.set("x-forwarded-host", "hub.test.ts.net");
    request.headers.set("x-forwarded-proto", "https");
    Object.defineProperty(request, "ip", { value: "172.20.0.1" });
    return handleAgentRequest(request, new AgentToolService(new MemoryWorkspaceStore()), env);
  });
  const discovery = await new TallyClient(endpoint).discover();
  assert.equal(discovery.authMode, "tailnet");
  assert.equal(discovery.storageConfigured, true);
  assert.equal(discovery.tools.length, 95);
  assert.equal(requests, 1);
});

test("automatic discovery keeps bearer deployments protected and accepts an explicit grant", async (t) => {
  const env = syntheticEnvironment();
  const endpoint = "http://127.0.0.1:8080/api/agent";
  t.mock.method(globalThis, "fetch", (url: string, init: RequestInit) =>
    handleAgentRequest(
      new Request(url, init),
      new AgentToolService(new MemoryWorkspaceStore()),
      env,
    ),
  );
  await assert.rejects(
    new TallyClient(endpoint).discover(),
    (error: unknown) =>
      error instanceof TallyClientError && error.code === "unauthorized" && error.status === 401,
  );
  assert.equal(
    (await new TallyClient(endpoint, SYNTHETIC_AGENT_TOKEN).discover()).authMode,
    "bearer",
  );
});

test("discovery reports storage and response failures instead of opening an invalid workspace", async (t) => {
  const client = new TallyClient("https://hub.test.ts.net/finance/api/agent");
  for (const body of [
    "<!doctype html><title>Wrong route</title>",
    { version: 2, authMode: "tailnet", storageConfigured: true, tools: [null] },
    { version: 2, authMode: "tailnet", storageConfigured: true, tools: {} },
    { version: 2, authMode: "tailnet", tools: [] },
    { version: 2, authMode: "tailnet", storageConfigured: false, tools: [] },
  ]) {
    t.mock.method(globalThis, "fetch", async () =>
      typeof body === "string" ? new Response(body) : Response.json(body),
    );
    await assert.rejects(
      client.discover(),
      (error: unknown) =>
        error instanceof TallyClientError &&
        error.code ===
          (typeof body === "object" && body.storageConfigured === false
            ? "storage_unconfigured"
            : "invalid_response"),
    );
  }
});

test("discovery forwards cancellation so an abandoned page cannot finish connecting", async (t) => {
  const controller = new AbortController();
  controller.abort();
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    assert.equal(init.signal, controller.signal);
    init.signal?.throwIfAborted();
    throw new Error("Expected an aborted request");
  });
  await assert.rejects(
    new TallyClient("https://hub.test.ts.net/finance/api/agent").discover(controller.signal),
    { name: "AbortError" },
  );
});
