import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { handleAgentRequest, readBounded } from "./http.server.ts";
import { AgentToolService } from "./service.ts";
import { MemoryWorkspaceStore } from "./store.ts";
import { authenticate, agentConfigurationReady } from "./auth.server.ts";
import {
  syntheticEnvironment,
  SYNTHETIC_AGENT_TOKEN,
  SYNTHETIC_OWNER_TOKEN,
} from "./test-fixtures.ts";
import { agentBaseUrl } from "./client.ts";
const env = syntheticEnvironment();
const request = (path = "", init: RequestInit = {}, token = SYNTHETIC_AGENT_TOKEN) =>
  new Request(`http://127.0.0.1:8080/finance/api/agent${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...init.headers },
  });
const payload = (tool: string, args = {}, key?: string) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    version: 2,
    tool: `tally_${tool}`,
    args,
    ...(key ? { idempotencyKey: key } : {}),
  }),
});
test("configuration fails closed, grants expire/revoke and agent self-approval is impossible", async () => {
  assert.equal(agentConfigurationReady({}), false);
  assert.equal(agentConfigurationReady(env), true);
  assert.equal(authenticate(request(), env).role, "agent");
  for (const token of ["short", "synthetic-unknown-token-which-is-long-enough"])
    assert.throws(() => authenticate(request("", {}, token), env), /grant/);
  const grants = JSON.parse(env.TALLY_AGENT_GRANTS_JSON);
  assert.equal(
    agentConfigurationReady({
      ...env,
      TALLY_AGENT_GRANTS_JSON: JSON.stringify([...grants, grants[0]]),
    }),
    false,
  );
  grants[0].scopes.push("owner:approve");
  assert.equal(
    agentConfigurationReady({ ...env, TALLY_AGENT_GRANTS_JSON: JSON.stringify(grants) }),
    false,
  );
  const expired = JSON.parse(env.TALLY_AGENT_GRANTS_JSON);
  expired[0].expiresAt = 1;
  assert.throws(
    () => authenticate(request(), { ...env, TALLY_AGENT_GRANTS_JSON: JSON.stringify(expired) }),
    /expired/,
  );
  assert.throws(
    () =>
      authenticate(request(), { ...env, TALLY_AGENT_GRANTS_JSON: JSON.stringify([expired[1]]) }),
    /revoked/,
  );
  assert.throws(
    () => authenticate(request("", { headers: { origin: "https://untrusted.invalid" } }), env),
    /origin/,
  );
  assert.throws(
    () =>
      authenticate(
        new Request("http://untrusted.invalid/api/agent", {
          headers: { authorization: `Bearer ${SYNTHETIC_AGENT_TOKEN}` },
        }),
        env,
      ),
    /origin/,
  );
  assert.equal(
    agentConfigurationReady({ ...env, TALLY_AGENT_PUBLIC_ORIGIN: "http://remote.invalid" }),
    false,
  );
});
test("private REST discovery, typed writes, limits and scope enforcement", async () => {
  const service = new AgentToolService(new MemoryWorkspaceStore());
  assert.equal((await handleAgentRequest(request(), service, {})).status, 503);
  const discovered = await handleAgentRequest(request(), service, env);
  assert.equal(discovered.status, 200);
  assert.equal((await discovered.json()).tools.length, 62);
  const created = await handleAgentRequest(
    request(
      "",
      payload(
        "create_transaction",
        {
          currency: "INR",
          expectedRevision: 0,
          transaction: {
            kind: "expense",
            amountMinor: 999,
            category: "Personal",
            date: "2026-10-13",
            note: "Synthetic REST entry",
          },
        },
        "synthetic-http-once",
      ),
    ),
    service,
    env,
  );
  assert.equal(created.status, 200);
  const result = await created.json();
  assert.equal(result.result.transaction.amountMinor, 999);
  assert.equal(
    (
      await handleAgentRequest(
        request("", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "a".repeat(16385),
        }),
        service,
        env,
      )
    ).status,
    413,
  );
  assert.equal(
    (
      await handleAgentRequest(
        request("", { method: "POST", headers: { "content-type": "application/json" }, body: "{" }),
        service,
        env,
      )
    ).status,
    400,
  );
  assert.equal(
    (await handleAgentRequest(request("", { method: "POST", body: "{}" }), service, env)).status,
    415,
  );
  const unknown = await handleAgentRequest(request("", payload("shell_exec")), service, env);
  assert.equal(unknown.status, 404);
  assert.equal((await handleAgentRequest(request("/approvals"), service, env)).status, 403);
  assert.equal(
    (await handleAgentRequest(request("/approvals", {}, SYNTHETIC_OWNER_TOKEN), service, env))
      .status,
    200,
  );
  assert.equal((await handleAgentRequest(request("/no-such-route"), service, env)).status, 404);
});
test("bounded streaming bodies and owned file upload/download never accept paths or URLs", async () => {
  const service = new AgentToolService(new MemoryWorkspaceStore());
  const uploaded = await handleAgentRequest(
    request("/files?currency=INR", {
      method: "POST",
      headers: { "content-type": "text/csv", "x-file-name": "../../synthetic.csv" },
      body: "Date,Amount\n2026-10-13,-1.00",
    }),
    service,
    env,
  );
  assert.equal(uploaded.status, 201);
  const file = (await uploaded.json()).result;
  assert.ok(!file.name.includes("/"));
  const response = await handleAgentRequest(
    request(`/files/${file.fileId}?currency=INR`),
    service,
    env,
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.ok((await response.text()).includes("Date,Amount"));
  assert.equal(
    (await handleAgentRequest(request(`/files/${file.fileId}?currency=USD`), service, env)).status,
    404,
  );
  assert.equal(
    (
      await handleAgentRequest(
        request(`/files/${file.fileId}?currency=INR`, {}, SYNTHETIC_OWNER_TOKEN),
        service,
        env,
      )
    ).status,
    404,
  );
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(9));
      controller.enqueue(new Uint8Array(9));
      controller.close();
    },
  });
  await assert.rejects(
    readBounded(
      new Request("http://127.0.0.1", {
        method: "POST",
        body: stream,
        duplex: "half",
      } as RequestInit),
      10,
    ),
    /size limit/,
  );
  assert.equal(
    agentBaseUrl({ origin: "https://hub.invalid", pathname: "/finance/agents" }),
    "https://hub.invalid/finance/api/agent",
  );
  assert.equal(
    agentBaseUrl({ origin: "http://127.0.0.1:8080", pathname: "/agents" }),
    "http://127.0.0.1:8080/api/agent",
  );
});
test("database faults return a scrubbed error", async () => {
  const service = new AgentToolService({
    transaction: async () => {
      throw new Error("postgresql://private-password@host SECRET FINANCIAL DATA");
    },
  });
  const response = await handleAgentRequest(
    request("", payload("get_ledger", { currency: "INR" })),
    service,
    env,
  );
  assert.equal(response.status, 503);
  assert.ok(!(await response.text()).includes("private-password"));
  assert.equal(createHash("sha256").update(SYNTHETIC_AGENT_TOKEN).digest("hex").length, 64);
});
