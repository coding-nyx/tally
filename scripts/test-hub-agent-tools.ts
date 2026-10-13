import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { catalog } from "../src/lib/agent-tools/catalog.ts";
import {
  SYNTHETIC_AGENT_TOKEN,
  SYNTHETIC_OWNER_TOKEN,
} from "../src/lib/agent-tools/test-fixtures.ts";

const base = new URL(process.env.TALLY_URL ?? "");
assert.equal(process.env.TALLY_TEST_MODE, "synthetic-hub-candidate");
assert.equal(base.origin, "http://127.0.0.1:3301");
assert.equal(process.env.TALLY_ACCESS_TOKEN, SYNTHETIC_AGENT_TOKEN);
const seen = new Set<string>();
const failures: Array<{ tool: string; expected: string }> = [];
const client = new Client({ name: "tally-hub-synthetic-check", version: "1" });
const environment = {
  TALLY_URL: base.href,
  TALLY_ACCESS_TOKEN: SYNTHETIC_AGENT_TOKEN,
  PATH: process.env.PATH ?? "",
};
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["--experimental-strip-types", "scripts/tally-mcp.ts"],
  env: environment,
  cwd: process.cwd(),
  stderr: "pipe",
});
async function call(
  name: string,
  args: Record<string, any> = {},
  key?: string,
  expectedError?: RegExp,
) {
  const tool = `tally_${name}`;
  seen.add(tool);
  const input = {
    ...args,
    ...(catalog[tool].effect === "read" ? {} : { idempotencyKey: key ?? randomUUID() }),
  };
  const response = await client.callTool({ name: tool, arguments: input });
  if (expectedError) {
    assert.equal(response.isError, true);
    assert.match(JSON.stringify(response.content), expectedError);
    failures.push({ tool, expected: expectedError.source });
    return {};
  }
  assert.ok(!response.isError, `${tool}: ${JSON.stringify(response.content)}`);
  const payload = response.structuredContent as { ok: boolean; result: Record<string, any> };
  assert.equal(payload.ok, true);
  return payload.result;
}
async function revision() {
  return (await call("get_ledger", { currency: "INR" })).revision as number;
}
async function write(name: string, args: Record<string, any> = {}, key?: string) {
  const needsRevision = Object.hasOwn(catalog[`tally_${name}`].schema.shape, "expectedRevision");
  return call(
    name,
    { currency: "INR", ...(needsRevision ? { expectedRevision: await revision() } : {}), ...args },
    key,
  );
}
async function http(path: string, init?: RequestInit, owner = false) {
  return fetch(new URL(path, base), {
    ...init,
    redirect: "error",
    headers: {
      ...init?.headers,
      authorization: `Bearer ${owner ? SYNTHETIC_OWNER_TOKEN : SYNTHETIC_AGENT_TOKEN}`,
    },
  });
}
async function upload(name: string, mime: string, bytes: Uint8Array | string) {
  const response = await http("api/agent/files?currency=INR", {
    method: "POST",
    headers: { "content-type": mime, "x-file-name": name },
    body: bytes as BodyInit,
  });
  assert.equal(response.status, 201);
  return (await response.json()).result;
}
async function approve(plan: Record<string, any>) {
  const approval = await call("request_approval", { currency: "INR", planId: plan.planId });
  const body = JSON.stringify({
    approvalId: approval.approvalId,
    previewHash: plan.previewHash,
    approve: true,
  });
  assert.equal(
    (
      await http("api/agent/approvals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      })
    ).status,
    403,
  );
  const rows = await http(
    `api/agent/approval-rows?approvalId=${approval.approvalId}`,
    undefined,
    true,
  );
  assert.equal(rows.status, 200);
  assert.equal(
    (
      await http(
        "api/agent/approvals",
        { method: "POST", headers: { "content-type": "application/json" }, body },
        true,
      )
    ).status,
    200,
  );
  await call("get_approval", { currency: "INR", approvalId: approval.approvalId });
  return approval.approvalId;
}
const transaction = {
  kind: "expense",
  amountMinor: 1250,
  category: "Groceries",
  date: "2026-10-13",
  note: "Synthetic hub groceries",
};
try {
  await client.connect(transport);
  const list = await client.listTools();
  assert.equal(list.tools.length, 62);
  const skill = await readFile("skills/tally/SKILL.md", "utf8");
  assert.match(skill, /name: tally/);
  assert.match(skill, /same idempotency key/);
  assert.match(skill, /owner/);
  const bundled = JSON.parse(await readFile("skills/tally/references/tools.json", "utf8"));
  assert.deepEqual(
    bundled.tools.map((t: any) => t.name).sort(),
    list.tools.map((t) => t.name).sort(),
  );
  const c = { currency: "INR" };
  const cm = { ...c, month: "2026-10" };
  for (const name of [
    "get_capabilities",
    "get_service_status",
    "list_ledgers",
    "get_preferences",
    "get_ai_status",
  ])
    await call(name);
  for (const name of [
    "get_ledger",
    "list_months",
    "list_categories",
    "verify_ledger_integrity",
    "get_recovery_status",
  ])
    await call(name, c);
  for (const name of [
    "get_month_settings",
    "get_savings_goal",
    "get_month_summary",
    "get_category_totals",
    "get_budget_status",
  ])
    await call(name, cm);
  await write("update_preferences");
  const cat = await write("create_category", { kind: "expense", name: "Synthetic courses" });
  const createArgs = { ...c, expectedRevision: await revision(), transaction };
  const createKey = randomUUID();
  const created = await call("create_transaction", createArgs, createKey);
  await write("update_transaction", {
    transactionId: created.transaction.id,
    patch: { amountMinor: 2500 },
  });
  const replay = await call("create_transaction", createArgs, createKey);
  assert.equal(replay.transaction.amountMinor, 1250);
  assert.equal(replay.transaction.id, created.transaction.id);
  await call("get_transaction", { ...c, transactionId: created.transaction.id });
  await call("list_transactions", { ...cm, limit: 1 });
  await write("set_savings_goal", {
    month: cm.month,
    name: "Synthetic private goal",
    targetMinor: 20000,
  });
  await write("set_category_budget", {
    month: cm.month,
    category: cat.category.name,
    limitMinor: 5000,
  });
  await write("update_category", { categoryId: cat.category.id, name: "Synthetic education" });
  await call("get_category_budget", { ...cm, category: "Synthetic education" });
  await write("archive_category", { categoryId: cat.category.id });
  await write("clear_category_budget", { month: cm.month, category: "Synthetic education" });
  await write("restore_category", { categoryId: cat.category.id });
  const batch = await write("prepare_batch_changes", {
    changes: [
      {
        action: "create",
        transaction: { ...transaction, category: "Synthetic education", note: "Synthetic course" },
      },
    ],
  });
  await write("commit_batch_changes", { planId: batch.planId, approvalId: await approve(batch) });
  await call("get_operation", { ...c, operationId: batch.planId });
  await call("get_operation_receipt", { ...c, operationId: batch.planId });
  const del = await write("prepare_delete_transaction", { transactionId: created.transaction.id });
  await write("delete_transaction", { planId: del.planId, approvalId: await approve(del) });
  const undo = await write("prepare_undo", { operationId: del.planId });
  await write("commit_undo", { planId: undo.planId, approvalId: await approve(undo) });
  const pending = await write("prepare_clear_month", { month: cm.month });
  await call("cancel_operation", { ...c, operationId: pending.planId });
  const mapping = {
    dateColumn: 0,
    descriptionColumn: 3,
    currencyColumn: 2,
    categoryColumn: 4,
    dateFormat: "auto",
    amount: { mode: "signed", amountColumn: 1, positiveAmounts: "income" },
  };
  const file = await upload(
    "synthetic.csv",
    "text/csv",
    "Date,Amount,Currency,Description,Category\n2026-10-13,-25.00,INR,Synthetic hub groceries,Groceries\n2026-02-30,-12.50,USD,Synthetic corrected course,Synthetic education",
  );
  const draft = await write("stage_statement", { fileId: file.fileId });
  await call("get_import", { ...c, importId: draft.importId });
  await call("set_import_mapping", { ...c, importId: draft.importId, mapping });
  const invalid = await write("preview_import", { importId: draft.importId });
  assert.equal(invalid.invalid, 1);
  await call("correct_import_rows", {
    ...c,
    importId: draft.importId,
    corrections: [
      {
        rowNumber: 3,
        values: [
          "2026-10-13",
          "-12.50",
          "INR",
          "Synthetic corrected course",
          "Synthetic education",
        ],
      },
    ],
  });
  const imported = await write("preview_import", { importId: draft.importId });
  assert.equal(imported.review.duplicates, 1);
  assert.equal(imported.review.valid, 1);
  const importArgs = {
    ...c,
    expectedRevision: imported.revision,
    planId: imported.planId,
    approvalId: await approve(imported),
  };
  const importKey = randomUUID();
  await call("commit_import", importArgs, importKey);
  await call("commit_import", importArgs, importKey);
  assert.equal(
    (await call("cancel_import", { ...c, importId: draft.importId })).status,
    "committed",
  );
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([600, 800]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const [text, x, y] of [
    ["Date", 40, 700],
    ["Description", 160, 700],
    ["Amount INR", 340, 700],
    ["2026-10-13", 40, 676],
    ["Synthetic PDF entry", 160, 676],
    ["-3.50", 340, 676],
  ] as const)
    page.drawText(text, { x, y, font, size: 10 });
  const pdfFile = await upload("synthetic.pdf", "application/pdf", await pdf.save());
  const pdfDraft = await write("stage_statement", { fileId: pdfFile.fileId });
  assert.equal(pdfDraft.rowCount, 1);
  await call("cancel_import", { ...c, importId: pdfDraft.importId });
  const scanned = await PDFDocument.create();
  scanned.addPage();
  const scannedFile = await upload(
    "synthetic-scanned.pdf",
    "application/pdf",
    await scanned.save(),
  );
  await call("stage_statement", { ...c, fileId: scannedFile.fileId }, undefined, /unsupported_pdf/);
  let backupBytes: Buffer | undefined;
  for (const name of ["export_transactions_csv", "export_monthly_pdf", "export_backup"]) {
    const file = await call(name, {
      ...c,
      ...(name === "export_monthly_pdf" ? { month: cm.month } : {}),
    });
    await call("get_file", { ...c, fileId: file.fileId });
    const resource = await client.readResource({ uri: `tally-file://INR/${file.fileId}` });
    const bytes = Buffer.from((resource.contents[0] as { blob: string }).blob, "base64");
    if (name === "export_monthly_pdf") assert.equal(bytes.toString("ascii", 0, 5), "%PDF-");
    if (name === "export_backup") backupBytes = bytes;
  }
  const backup = await upload("synthetic-backup.json", "application/json", backupBytes!);
  await write("create_transaction", {
    transaction: { ...transaction, note: "Synthetic post-backup entry" },
  });
  const restore = await write("preview_restore", { fileId: backup.fileId });
  const restored = await write("commit_restore", {
    planId: restore.planId,
    approvalId: await approve(restore),
  });
  assert.ok(restored.backupFileId);
  await call("export_raw_recovery", { ...c, fileId: backup.fileId });
  const context = await call("create_analysis_context", { ...cm, question: "What did I spend?" });
  assert.ok(!JSON.stringify(context.review).includes("Synthetic private goal"));
  await call(
    "ask_spending_question",
    {
      ...c,
      contextId: context.contextId,
      approvalId: "no-provider",
      question: "What did I spend?",
    },
    undefined,
    /provider_unconfigured/,
  );
  await call(
    "get_ai_request",
    { ...c, requestId: "nonexistent-synthetic" },
    undefined,
    /not_found/,
  );
  await call(
    "cancel_ai_request",
    { ...c, requestId: "nonexistent-synthetic" },
    undefined,
    /not_found/,
  );
  const samples = await write("prepare_remove_sample_entries");
  await write("remove_sample_entries", {
    planId: samples.planId,
    approvalId: await approve(samples),
  });
  const clear = await write("prepare_clear_month", { month: cm.month });
  await write("clear_month", { planId: clear.planId, approvalId: await approve(clear) });
  await call("list_audit_events", c);
  assert.equal((await call("get_ledger", { currency: "USD" })).revision, 0);
  assert.deepEqual(
    Object.keys(catalog).filter((name) => !seen.has(name)),
    [],
  );
  await client.close();
  const modern = new Client(
    { name: "tally-hub-modern-check", version: "1" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  try {
    await modern.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ["--experimental-strip-types", "scripts/tally-mcp.ts"],
        env: environment,
        cwd: process.cwd(),
        stderr: "pipe",
      }),
    );
    assert.equal((await modern.listTools()).tools.length, 62);
    const result = await modern.callTool({
      name: "tally_get_ledger",
      arguments: { currency: "INR" },
    });
    assert.ok(!result.isError);
  } finally {
    await modern.close();
  }
  console.log(
    JSON.stringify(
      {
        passed: true,
        exercisedOperations: seen.size,
        protocols: ["legacy-2025", "2026-07-28"],
        expectedBlockedCases: failures,
        skillCatalogMatches: true,
        realProviderCalls: 0,
        financialData: "synthetic-only",
      },
      null,
      2,
    ),
  );
} finally {
  await client.close();
}
