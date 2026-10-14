import assert from "node:assert/strict";
import { auditFeatures } from "./qa-ui-features.mjs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { createServer as httpServer, request as httpRequest } from "node:http";
import { createServer as httpsServer } from "node:https";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { chromium } from "playwright";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
assert.equal(process.env.TALLY_QA_ISOLATED, "true", "Run only in the disposable QA driver");
const db = process.env.TALLY_AGENT_DATABASE_URL;
assert.equal(new URL(db).hostname, "tally-ux-audit-db");
const origin = "https://synthetic.ts.net:8443",
  base = origin + "/finance/";
const pool = new pg.Pool({ connectionString: db, max: 1 });
let app,
  http,
  https,
  client,
  browser,
  page,
  log = "",
  bridgeErrors = "",
  loseNextResponse = false,
  failReads = false,
  testingConflict = false;
const report = {
  ok: false,
  productionAccess: false,
  transport:
    "real token-free MCP stdio -> verified fixture TLS -> synthetic private ingress -> compiled runtime -> PostgreSQL 17",
  ingress: "isolated synthetic proxy, not an actual Tailscale hop",
  calls: [],
  snapshots: [],
  browser: [],
};
async function call(name, args = {}, key, expectedError) {
  const response = await client.callTool({
    name: "tally_" + name,
    arguments: { ...args, ...(key ? { idempotencyKey: key } : {}) },
  });
  report.calls.push({
    name,
    expectedError: !!expectedError,
    replayed: response.structuredContent?.replayed === true,
  });
  if (expectedError) {
    assert.equal(response.isError, true);
    assert.match(JSON.stringify(response.content), expectedError);
    return;
  }
  assert.ok(!response.isError, JSON.stringify(response.content));
  assert.equal(response.structuredContent?.ok, true);
  return response.structuredContent;
}
async function connect() {
  client = new Client({ name: "synthetic-server-dashboard", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--experimental-strip-types", "scripts/tally-mcp.ts"],
    cwd: "/app",
    env: {
      PATH: process.env.PATH,
      TALLY_URL: base,
      TALLY_AUTH_MODE: "tailnet",
      NODE_EXTRA_CA_CERTS: "/qa-tls/fixture-cert.pem",
    },
    stderr: "pipe",
  });
  transport.stderr?.on("data", (c) => (bridgeErrors += c));
  await client.connect(transport);
  assert.equal((await client.listTools()).tools.length, 99);
}
async function revision(currency = "INR") {
  return (await call("get_ledger", { currency })).result.revision;
}
try {
  for (const name of (await readdir("/qa-schema"))
    .filter((n) => /^\d{4}_[a-z_]+\.sql$/.test(n))
    .sort())
    await pool.query(await readFile("/qa-schema/" + name, "utf8"));
  app = spawn(process.execPath, ["scripts/start-tally.mjs"], {
    cwd: "/candidate",
    env: {
      ...process.env,
      TALLY_AGENT_ENABLED: "true",
      TALLY_AGENT_AUTH_MODE: "tailnet",
      TALLY_AGENT_WORKSPACE_ID: "synthetic-server-dashboard",
      TALLY_AGENT_PUBLIC_ORIGIN: origin,
      TALLY_AGENT_TRUSTED_PROXY_IPS: "127.0.0.1",
      TALLY_STATEMENTS_ENABLED: "true",
      TALLY_AI_PROVIDER: "",
      TALLY_AI_API_KEY: "",
      HOST: "127.0.0.1",
      PORT: "3001",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  app.stdout.on("data", (c) => (log += c));
  app.stderr.on("data", (c) => (log += c));
  for (let n = 0; n < 60; n++) {
    try {
      if ((await fetch("http://127.0.0.1:3001/finance/")).ok) break;
    } catch {
      /* readiness may precede startup */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.equal((await fetch("http://127.0.0.1:3001/finance/api/agent")).status, 403);
  const proxy = async (req, res) => {
    if (failReads && req.url.includes("/api/agent")) {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ ok: false, error: { code: "unavailable", message: "Synthetic outage" } }),
      );
      return;
    }
    assert.ok(!req.headers.authorization);
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    let input;
    try {
      input = JSON.parse(body.toString());
    } catch {
      /* readiness may precede startup */
    }
    const lose =
      loseNextResponse &&
      input?.tool === "tally_create_transaction" &&
      input.args.transaction.note === "Synthetic interrupted response";
    if (lose) loseNextResponse = false;
    if (
      input?.tool === "tally_create_transaction" &&
      input.args.transaction.note === "Synthetic interrupted response"
    ) {
      (report.interruptedKeys ??= []).push(input.idempotencyKey);
    }
    const headers = {
      ...req.headers,
      host: "synthetic.ts.net:8443",
      "x-forwarded-host": "synthetic.ts.net:8443",
      "x-forwarded-proto": "https",
      "x-forwarded-for": "100.64.0.2, 127.0.0.1",
    };
    if (headers.origin) headers.origin = origin;
    const upstream = httpRequest(
      { hostname: "127.0.0.1", port: 3001, path: req.url, method: req.method, headers },
      (r) => {
        if (r.statusCode === 409) {
          const parts = [];
          r.on("data", (c) => parts.push(c));
          r.on("end", () => {
            const value = JSON.parse(Buffer.concat(parts).toString());
            (report.conflicts ??= []).push({
              tool: input?.tool,
              expectedRevision: input?.args?.expectedRevision,
              code: value.error?.code,
            });
          });
        }
        if (lose) {
          r.resume();
          r.on("end", () => {
            assert.equal(r.statusCode, 200);
            res.writeHead(503, { "content-type": "application/json" });
            res.end(
              JSON.stringify({
                ok: false,
                error: { code: "unavailable", message: "Synthetic lost response after commit" },
              }),
            );
          });
        } else {
          res.writeHead(r.statusCode, r.headers);
          r.pipe(res);
        }
      },
    );
    upstream.on("error", () => {
      res.writeHead(502);
      res.end();
    });
    upstream.end(body);
  };
  https = httpsServer(
    {
      key: await readFile("/qa-tls/fixture-key.pem"),
      cert: await readFile("/qa-tls/fixture-cert.pem"),
    },
    proxy,
  );
  http = httpServer(proxy);
  await new Promise((r) => https.listen(8443, "127.0.0.1", r));
  await new Promise((r) => http.listen(9000, "127.0.0.1", r));
  await connect();
  await call("get_capabilities");
  await call("get_service_status");
  await call("list_ledgers");
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const errors = [],
    expectedConsole = [];
  report.consoleErrors = errors;
  const fonts = JSON.parse(await readFile("/qa-fonts/manifest.json", "utf8"));
  async function context(poison, width = 1280) {
    const ctx = await browser.newContext({
      viewport: { width, height: width === 390 ? 844 : 900 },
      timezoneId: "Asia/Kolkata",
      acceptDownloads: true,
    });
    await ctx.route("https://fonts.googleapis.com/**", async (r) =>
      r.fulfill({ contentType: "text/css", body: await readFile("/qa-fonts/fonts.css") }),
    );
    await ctx.route("https://fonts.gstatic.com/**", async (r) =>
      r.fulfill({
        contentType: "font/ttf",
        body: await readFile("/qa-fonts/" + fonts[r.request().url()].file),
      }),
    );
    await ctx.route("https://grok.com/grok-app-builder/extensions.js", async (r) =>
      r.fulfill({
        contentType: "text/javascript",
        body: await readFile("/qa-fonts/platform-extensions.js"),
      }),
    );
    await ctx.addInitScript(
      ({ poison }) => {
        const get = Storage.prototype.getItem,
          set = Storage.prototype.setItem;
        if (poison) set.call(localStorage, "tally.budget.v2.INR", "SYNTHETIC_OLD_BROWSER_DATA");
        window.__tallyStorage = [];
        window.__preservedBudget = () => get.call(localStorage, "tally.budget.v2.INR");
        const remove = Storage.prototype.removeItem,
          clear = Storage.prototype.clear;
        Storage.prototype.removeItem = function (k) {
          if (k.startsWith("tally.")) window.__tallyStorage.push(["remove", k]);
          return remove.call(this, k);
        };
        Storage.prototype.clear = function () {
          window.__tallyStorage.push(["clear"]);
          return clear.call(this);
        };
        Storage.prototype.getItem = function (k) {
          if (k.startsWith("tally.")) window.__tallyStorage.push(["get", k]);
          return get.call(this, k);
        };
        Storage.prototype.setItem = function (k, v) {
          if (k.startsWith("tally.")) window.__tallyStorage.push(["set", k]);
          return set.call(this, k, v);
        };
      },
      { poison },
    );
    const p = await ctx.newPage();
    p.on("pageerror", (e) => errors.push(String(e)));
    p.on("console", (m) => {
      if (m.type() === "error") {
        if (
          (failReads && m.text().includes("503")) ||
          (testingConflict && m.text().includes("409"))
        )
          expectedConsole.push(m.text());
        else errors.push(m.text());
      }
    });
    return p;
  }

  async function commitPlan(preview, tool) {
    assert.equal(preview.approvalRequired, false);
    const args = {
      currency: "INR",
      expectedRevision: preview.revision,
      planId: preview.planId,
      previewHash: preview.previewHash,
    };
    const key = randomUUID();
    await call(tool, args, key);
    assert.equal((await call(tool, args, key)).replayed, true);
  }
  async function investment(change) {
    const p = (
      await call(
        "prepare_investment_change",
        { currency: "INR", expectedRevision: await revision(), change },
        randomUUID(),
      )
    ).result;
    await commitPlan(p, "commit_investment_change");
    return p.review.change;
  }
  async function account(name, type, balance) {
    const p = (
      await call(
        "prepare_account",
        {
          currency: "INR",
          expectedRevision: await revision(),
          name,
          type,
          opening: { date: "2026-10-01", timing: "start_of_day", balanceMinor: balance },
          ...(type === "credit_card" ? { cardTerms: { creditLimitMinor: 50000 } } : {}),
        },
        randomUUID(),
      )
    ).result;
    await commitPlan(p, "commit_account_change");
    return p.review.change.account.id;
  }
  const bankId = await account("Synthetic bank", "bank", 100000),
    cardId = await account("Synthetic card", "credit_card", 10000);
  const ia = (
    await investment({
      action: "account",
      name: "Synthetic investment account",
      institution: "Fixture",
    })
  ).account.id;
  const v = {
    date: "2026-10-01",
    quantity: "1.125",
    costMinor: 10000,
    valueMinor: 12500,
    note: "Synthetic observed value",
  };
  for (const type of ["mutual_fund", "gold", "stock", "recurring_deposit"])
    await investment({
      action: "holding",
      accountId: ia,
      type,
      name: "Synthetic " + type,
      valuation: {
        ...v,
        ...(type === "recurring_deposit"
          ? {
              rd: {
                instalmentMinor: 1000,
                maturityDate: "2027-10-01",
                expectedMaturityMinor: 15000,
              },
            }
          : {}),
      },
    });
  const initial = (await call("get_investment_portfolio", { currency: "INR", asOf: "2026-10-14" }))
    .result;
  assert.equal(initial.valueMinor, 50000);
  assert.equal(initial.holdings.length, 4);
  await client.close();
  await connect();
  assert.equal(
    (await call("get_investment_portfolio", { currency: "INR", asOf: "2026-10-14" })).result
      .valueMinor,
    50000,
  );
  const staleInvestment = (
    await call(
      "prepare_investment_change",
      {
        currency: "INR",
        expectedRevision: await revision(),
        change: {
          action: "archive_holding",
          holdingId: initial.holdings[0].holding.id,
          archived: true,
        },
      },
      randomUUID(),
    )
  ).result;
  page = await context(false);
  const mobile = await context(true, 390);
  const url = "http://127.0.0.1:9000/finance/agents?section=investments&currency=INR&month=2026-10";
  await Promise.all([page.goto(url), mobile.goto(url)]);
  for (const p of [page, mobile]) {
    await p.getByRole("heading", { name: "Synthetic gold", exact: true }).waitFor();
    assert.equal(await p.getByRole("button", { name: "Connect", exact: true }).count(), 0);
    await p.getByText("₹500.00", { exact: true }).waitFor();
  }
  await page.getByLabel("Holding", { exact: true }).selectOption(initial.holdings[0].holding.id);
  await page.getByLabel("Observation date", { exact: true }).fill("2026-10-14");
  await page.getByLabel("Units (optional for RD)", { exact: true }).fill("1.125");
  await page.getByLabel("Remaining cost basis (INR)", { exact: true }).fill("100.00");
  await page.getByLabel("Total observed value (INR)", { exact: true }).fill("140.00");
  await page.getByLabel("Source / note", { exact: true }).fill("Synthetic browser valuation");
  await page.getByRole("button", { name: "Preview holding / valuation", exact: true }).click();
  await page.getByRole("region", { name: "Financial preview", exact: true }).waitFor();
  assert.equal(
    (await call("get_investment_portfolio", { currency: "INR", asOf: "2026-10-14" })).result
      .valueMinor,
    50000,
  );
  await page.getByRole("button", { name: "Commit displayed preview", exact: true }).click();
  await page
    .getByRole("region", { name: "Financial preview", exact: true })
    .waitFor({ state: "hidden" });
  await page.getByText("₹515.00", { exact: true }).waitFor();
  const after = (await call("get_investment_portfolio", { currency: "INR", asOf: "2026-10-14" }))
    .result;
  assert.equal(after.valueMinor, 51500);
  await call(
    "commit_investment_change",
    {
      currency: "INR",
      expectedRevision: staleInvestment.revision,
      planId: staleInvestment.planId,
      previewHash: staleInvestment.previewHash,
    },
    randomUUID(),
    /revision_conflict/,
  );
  await call(
    "cancel_operation",
    { currency: "INR", operationId: staleInvestment.planId },
    randomUUID(),
  );
  const history = (
    await call("list_investment_valuations", {
      currency: "INR",
      holdingId: initial.holdings[0].holding.id,
      limit: 1,
    })
  ).result;
  assert.equal(history.items[0].valueMinor, 14000);
  assert.ok(history.nextCursor);
  const older = (
    await call("list_investment_valuations", {
      currency: "INR",
      holdingId: initial.holdings[0].holding.id,
      limit: 1,
      cursor: history.nextCursor,
    })
  ).result;
  assert.equal(older.items[0].valueMinor, 12500);
  assert.equal(
    (await call("get_investment_portfolio", { currency: "USD", asOf: "2026-10-14" })).result
      .holdings.length,
    0,
  );
  await mobile.reload();
  await mobile.getByText("₹515.00", { exact: true }).waitFor();
  for (const [name, p] of [
    ["investments-desktop", page],
    ["investments-mobile", mobile],
  ]) {
    await p.evaluate(() => document.fonts.ready);
    await p.screenshot({ path: "/qa-output/" + name + ".png", fullPage: true });
    assert.equal(await p.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.deepEqual(await p.evaluate(() => window.__tallyStorage), []);
  }
  await page.goto(
    "http://127.0.0.1:9000/finance/agents?section=accounts&currency=INR&month=2026-10",
  );
  await page.getByRole("heading", { name: "Synthetic card", exact: true }).waitFor();
  const form = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Credit card limits and bills", exact: true }),
  });
  await form.getByLabel("Card", { exact: true }).selectOption(cardId);
  await form.getByLabel("Statement date (end of day)", { exact: true }).fill("2026-10-02");
  await form.getByLabel("Payment due date", { exact: true }).fill("2026-10-10");
  await form.getByLabel("Total statement due", { exact: true }).fill("100.00");
  await form.getByLabel("Minimum due", { exact: true }).fill("10.00");
  await form.getByRole("button", { name: "Preview card details", exact: true }).click();
  await page.getByRole("heading", { name: "Review proposed change", exact: true }).waitFor();
  await page.getByRole("button", { name: "Commit displayed change", exact: true }).click();
  await page
    .getByRole("heading", { name: "Review proposed change", exact: true })
    .waitFor({ state: "hidden" });
  const pay = (
    await call(
      "prepare_journal_event",
      {
        currency: "INR",
        expectedRevision: await revision(),
        event: {
          kind: "card_payment",
          fromAccountId: bankId,
          toAccountId: cardId,
          amountMinor: 4000,
          date: "2026-10-05",
          note: "Synthetic card repayment",
        },
      },
      randomUUID(),
    )
  ).result;
  await commitPlan(pay, "commit_journal_event");
  await page.reload();
  await page.getByText("Statement due remaining: ₹60.00", { exact: true }).waitFor();
  const card = (
    await call("get_account_balance", { currency: "INR", accountId: cardId, asOf: "2026-10-14" })
  ).result;
  assert.equal(card.balanceMinor, 6000);
  assert.equal(card.card.remainingDueMinor, 6000);
  assert.equal(
    (
      await call("get_income_expense_report", {
        currency: "INR",
        from: "2026-10-01",
        to: "2026-10-14",
      })
    ).result.expenseMinor,
    0,
  );
  await page.screenshot({ path: "/qa-output/cards-desktop.png", fullPage: true });
  await mobile.goto(
    "http://127.0.0.1:9000/finance/agents?section=accounts&currency=INR&month=2026-10",
  );
  await mobile.getByText("Statement due remaining: ₹60.00", { exact: true }).waitFor();
  assert.equal(
    await mobile.evaluate(() => document.documentElement.scrollWidth > innerWidth),
    false,
  );
  await mobile.screenshot({ path: "/qa-output/cards-mobile.png", fullPage: true });
  report.stage = "extended-ui-mcp-audit";
  await auditFeatures({
    page,
    mobile,
    context,
    call,
    revision,
    commitPlan,
    account,
    bankId,
    cardId,
    report,
  });
  const doc = (
    await pool.query("SELECT document FROM tally_agent_workspaces WHERE owner_id=$1", [
      "synthetic-server-dashboard",
    ])
  ).rows[0].document;
  assert.equal(doc.ledgers.INR.investments.valuations.length, 5);
  assert.equal(Object.keys(doc.approvals).length, 0);
  assert.ok(
    Number((await pool.query("SELECT count(*) AS n FROM tally_financial_accounts")).rows[0].n) >= 6,
  );
  assert.equal(
    await mobile.evaluate(() => window.__preservedBudget()),
    "SYNTHETIC_OLD_BROWSER_DATA",
  );
  assert.deepEqual(errors, []);
  report.ok = true;
  report.uniqueMcpTools = [...new Set(report.calls.map((c) => "tally_" + c.name))];
  report.summary = {
    investmentTypes: ["mutual_fund", "gold", "stock", "recurring_deposit"],
    investmentAccounts: 1,
    holdings: 4,
    valuations: 5,
    independentBrowsers: 2,
    realMcpBridgeRestart: true,
    previewDoesNotPost: true,
    browserValuationCommit: true,
    actualMcpHistoryPaging: true,
    staleMcpPreviewRejected: true,
    desktopMobileMatch: true,
    cardsDesktopMobileMatch: true,
    browserCardBillCommit: true,
    settlementNotSpending: true,
    currencyIsolation: true,
    zeroOwnerApprovalObjects: true,
    financialBrowserStorageAccesses: 0,
    consoleErrors: errors,
    financialSqlSeeds: 0,
  };
} catch (error) {
  report.error = error.stack;
  process.exitCode = 1;
  if (page) {
    report.failedBrowserText = await page
      .locator("body")
      .innerText()
      .catch(() => null);
    await page.screenshot({ path: "/qa-output/failure.png", fullPage: true }).catch(() => {});
  }
} finally {
  await browser?.close().catch(() => {});
  await client?.close().catch(() => {});
  http?.closeAllConnections();
  https?.closeAllConnections();
  http?.close();
  https?.close();
  app?.kill("SIGTERM");
  await pool.end();
  await writeFile("/qa-output/verification.json", JSON.stringify(report, null, 2) + "\n");
  await writeFile("/qa-output/app.log", log);
  await writeFile("/qa-output/bridge.log", bridgeErrors);
  console.log(JSON.stringify({ ok: report.ok, summary: report.summary, error: report.error }));
}
process.exit(process.exitCode ?? 0);
