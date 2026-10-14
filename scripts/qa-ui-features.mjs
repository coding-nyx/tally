import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { catalog } from "../src/lib/agent-tools/catalog.ts";

/** Called only by the explicitly guarded disposable candidate driver. */
export async function auditFeatures({
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
}) {
  const result = (name) => {
    (report.featureChecks ??= []).push(name);
    console.log("PASS " + name);
  };
  const write = async (name, args = {}) =>
    (
      await call(
        name,
        {
          currency: "INR",
          ...(Object.hasOwn(catalog[`tally_${name}`].schema.shape, "expectedRevision")
            ? { expectedRevision: await revision() }
            : {}),
          ...args,
        },
        randomUUID(),
      )
    ).result;
  const nav = async (p, section) => {
    await p.goto(
      `http://127.0.0.1:9000/finance/agents?currency=INR&month=2026-10&section=${section}`,
    );
    await p.getByText(/One private server workspace · revision/).waitFor();
  };
  const loanId = await account("Synthetic education loan", "loan", 50000);
  await account("Synthetic cash wallet", "cash", 5000);
  for (const event of [
    {
      kind: "loan_borrowing",
      assetAccountId: bankId,
      loanAccountId: loanId,
      amountMinor: 8000,
      date: "2026-10-06",
      note: "Synthetic drawdown",
    },
    {
      kind: "loan_payment",
      assetAccountId: bankId,
      loanAccountId: loanId,
      principalMinor: 5000,
      allocations: [{ categoryId: "expense:Personal", amountMinor: 1000, component: "interest" }],
      date: "2026-10-07",
      note: "Synthetic loan instalment",
    },
  ])
    await commitPlan(await write("prepare_journal_event", { event }), "commit_journal_event");
  assert.equal(
    (await call("get_account_balance", { currency: "INR", accountId: loanId, asOf: "2026-10-14" }))
      .result.balanceMinor,
    53000,
  );
  assert.equal(
    (await call("get_cash_flow", { currency: "INR", from: "2026-10-01", to: "2026-10-31" })).result
      .netAssetMovementMinor,
    -2000,
  );
  result("MCP loan drawdown, principal and interest; cash-flow arithmetic");
  await nav(page, "accounts");
  const localToday = await page.evaluate(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  });
  assert.equal(await page.getByLabel("Balances as of", { exact: true }).inputValue(), localToday);
  await page.getByRole("button", { name: "Loans & debt", exact: true }).click();
  await page.getByText(/Recorded principal outstanding: ₹530.00/).waitFor();
  assert.equal(await page.getByRole("heading", { name: "Synthetic bank", exact: true }).count(), 0);
  await page.getByRole("button", { name: "All accounts", exact: true }).click();
  const creation = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Add bank account, card or loan", exact: true }),
  });
  for (const [type, name] of [
    ["bank", "Synthetic UI bank"],
    ["credit_card", "Synthetic UI card"],
    ["loan", "Synthetic UI loan"],
  ]) {
    await creation.getByLabel("Account name", { exact: true }).fill(name);
    await creation.getByLabel("Account type", { exact: true }).selectOption(type);
    await creation
      .getByLabel("Institution (optional)", { exact: true })
      .fill("Synthetic institution");
    await creation.getByLabel("Last four digits (optional)", { exact: true }).fill("1234");
    await creation.getByRole("button", { name: "Prepare account preview", exact: true }).click();
    await page.getByRole("heading", { name: "Review proposed change", exact: true }).waitFor();
    await page.getByRole("button", { name: "Commit displayed change", exact: true }).click();
    await page.getByRole("heading", { name: name, exact: true }).waitFor();
    await page
      .getByRole("heading", { name: "Review proposed change", exact: true })
      .waitFor({ state: "hidden" });
  }
  const uiCard = (await call("list_accounts", { currency: "INR" })).result.accounts.find(
    (a) => a.name === "Synthetic UI card",
  );
  assert.equal(uiCard.institution, "Synthetic institution");
  assert.equal(uiCard.lastFour, "1234");
  const tile = page
    .locator("div.rounded.border")
    .filter({ has: page.getByRole("heading", { name: "Synthetic UI card", exact: true }) })
    .first();
  await tile.getByRole("button", { name: "Edit account details", exact: true }).click();
  const details = page.getByRole("form", { name: "Edit Synthetic UI card", exact: true });
  await details.getByLabel("Display name", { exact: true }).fill("Synthetic UI card renamed");
  await details.getByLabel("Bank / institution", { exact: true }).fill("Synthetic new bank");
  await details.getByRole("button", { name: "Preview account details", exact: true }).click();
  await page.getByRole("button", { name: "Commit displayed change", exact: true }).click();
  await page.getByRole("heading", { name: "Synthetic UI card renamed", exact: true }).waitFor();
  const updated = (await call("get_account", { currency: "INR", accountId: uiCard.id })).result
    .account;
  assert.equal(updated.institution, "Synthetic new bank");
  assert.equal(updated.lastFour, "1234");
  result("UI bank/card/loan creation, loan filter and metadata edit agree with MCP");

  // Statement source bytes are synthetic and uploaded through the same private HTTP adapter.
  const upload = await page.request.post(
    "http://127.0.0.1:9000/finance/api/agent/files?currency=INR",
    {
      headers: {
        "content-type": "text/csv",
        "x-file-name": "synthetic-audit.csv",
        "x-tally-request": "1",
        origin: "http://127.0.0.1:9000",
      },
      data: "Date,Description,Amount,Reference\n2026-10-08,Synthetic cafe,-5.00,qa-one",
    },
  );
  assert.equal(upload.status(), 201);
  const file = (await upload.json()).result;
  const staged = await write("stage_account_statement", {
    accountId: bankId,
    fileId: file.fileId,
    periodFrom: "2026-10-01",
    periodTo: "2026-10-31",
    closingMinor: 97500,
    closingTiming: "end_of_day",
  });
  const revised = await write("revise_account_statement", {
    statementId: staged.statementId,
    mapping: {
      dateColumn: 0,
      descriptionColumn: 1,
      currencyColumn: null,
      dateFormat: "auto",
      amount: { mode: "signed", amountColumn: 2, positiveAmounts: "income" },
      referenceColumn: 3,
    },
    reason: "Synthetic reviewed CSV convention",
  });
  staged.statementId = revised.statementId;
  const stmt = (
    await call("get_account_statement", { currency: "INR", statementId: staged.statementId })
  ).result;
  await call("get_statement_matches", { currency: "INR", statementId: staged.statementId });
  const plan = await write("prepare_statement_changes", {
    statementIds: [staged.statementId],
    decisions: stmt.items.map((o) => ({
      action: "create",
      observationIds: [o.id],
      event: {
        kind: "expense",
        accountId: bankId,
        date: o.date,
        allocations: [{ categoryId: "expense:Personal", amountMinor: 500 }],
        note: "Synthetic cafe",
      },
      reason: "Explicit synthetic posting",
    })),
  });
  await commitPlan(plan, "commit_statement_changes");
  await commitPlan(
    await write("prepare_statement_reconciliation", { statementId: staged.statementId }),
    "commit_statement_reconciliation",
  );
  const coverage = (
    await call("get_statement_coverage", {
      currency: "INR",
      accountId: bankId,
      from: "2026-10-01",
      to: "2026-10-31",
    })
  ).result;
  assert.equal(coverage.statements[0].reconciliation.status, "incomplete");
  assert.equal(coverage.statements[0].reconciliation.differenceMinor, 0);
  assert.ok(coverage.statements[0].reconciliation.unobservedEventIds.length > 0);
  await nav(page, "statements");
  await page.getByRole("button", { name: /Synthetic bank · 2026-10-01–2026-10-31/ }).waitFor();
  result("Real MCP statement upload/map/classify/commit/reconcile and UI retained evidence");

  const expense = (
    await write("create_transaction", {
      transaction: {
        kind: "expense",
        amountMinor: 2500,
        category: "Personal",
        date: "2026-10-14",
        note: "Synthetic dashboard expense",
      },
    })
  ).transaction;
  await write("create_transaction", {
    transaction: {
      kind: "income",
      amountMinor: 100000,
      category: "Pay",
      date: "2026-10-01",
      note: "Synthetic dashboard salary",
    },
  });
  const root = "http://127.0.0.1:9000/finance/?currency=INR&month=2026-10";
  await page.goto(root);
  await page
    .getByText(`Private server ledger · revision ${await revision()}`, { exact: true })
    .waitFor();
  await page.getByRole("button", { name: "Add entry", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Amount", { exact: true }).fill("20.00");
  await dialog.getByLabel("Category", { exact: true }).selectOption("Personal");
  await dialog.getByLabel("Date", { exact: true }).fill("2026-10-14");
  await dialog.getByLabel("Note", { exact: false }).fill("Synthetic UI expense");
  await dialog.getByRole("button", { name: "Add entry", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await page
    .getByRole("button", { name: "Edit Personal, Synthetic UI expense", exact: true })
    .click();
  await dialog.getByLabel("Amount", { exact: true }).fill("22.00");
  await dialog.getByRole("button", { name: "Save changes", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  const goal = page.locator('section[aria-labelledby="goal-heading"]');
  await goal.getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Synthetic reserve");
  await page.getByLabel("Monthly target", { exact: true }).fill("100.00");
  await page.getByRole("button", { name: "Save goal", exact: true }).click();
  await goal.getByRole("button", { name: "Edit", exact: true }).waitFor();
  const budget = page.getByRole("form", { name: "Personal monthly budget", exact: true });
  await budget.getByLabel("Monthly limit for Personal", { exact: true }).fill("40.00");
  await budget.getByRole("button", { name: "Save", exact: true }).click();
  await page
    .getByText(`Private server ledger · revision ${await revision()}`, { exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "Delete Personal, Synthetic UI expense", exact: true })
    .click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await page.getByRole("region", { name: "Frozen change preview", exact: true }).waitFor();
  assert.equal(
    (await call("list_transactions", { currency: "INR", month: "2026-10" })).result.items.length,
    3,
  );
  await page.getByRole("button", { name: "Commit displayed preview", exact: true }).click();
  await page
    .getByRole("region", { name: "Frozen change preview", exact: true })
    .waitFor({ state: "hidden" });
  assert.equal(
    (await call("list_transactions", { currency: "INR", month: "2026-10" })).result.items.length,
    2,
  );
  await call("get_transaction", { currency: "INR", transactionId: expense.id });
  let backupPath;
  for (const label of ["Export CSV", "Export monthly PDF", "Export backup"]) {
    await page.getByLabel("More data actions", { exact: true }).first().click();
    const event = page.waitForEvent("download");
    await page.getByRole("button", { name: label, exact: true }).click();
    const download = await event;
    const destination = "/qa-output/" + download.suggestedFilename();
    await download.saveAs(destination);
    if (label === "Export backup") backupPath = destination;
  }
  assert.equal(
    (await call("get_month_settings", { currency: "INR", month: "2026-10" })).result.settings
      .goalName,
    "Synthetic reserve",
  );
  result("UI dashboard add/edit/preview-delete, goals/budgets and CSV/PDF/JSON downloads");

  await nav(page, "imports");
  await page.getByLabel("CSV or text PDF", { exact: true }).setInputFiles({
    name: "synthetic-budget.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(
      "Date,Description,Amount,Category\n2026-10-14,Synthetic UI CSV,3.00,Personal",
    ),
  });
  await page.getByRole("heading", { name: "1 staged rows", exact: true }).waitFor();
  await page.getByLabel("Column mapping", { exact: true }).fill(
    JSON.stringify({
      dateColumn: 0,
      descriptionColumn: 1,
      currencyColumn: null,
      categoryColumn: 3,
      dateFormat: "auto",
      amount: { mode: "signed", amountColumn: 2, positiveAmounts: "expense" },
    }),
  );
  await page.getByRole("button", { name: "Apply mapping", exact: true }).click();
  await page.getByRole("button", { name: "Preview import", exact: true }).click();
  await page.getByRole("heading", { name: "Review", exact: true }).waitFor();
  assert.equal(
    (await call("list_transactions", { currency: "INR", month: "2026-10" })).result.items.length,
    2,
  );
  await page.getByRole("button", { name: "Commit displayed preview", exact: true }).click();
  await page.getByRole("heading", { name: "Review", exact: true }).waitFor({ state: "hidden" });
  const imported = (
    await call("list_transactions", { currency: "INR", month: "2026-10" })
  ).result.items.find((t) => t.note === "Synthetic UI CSV");
  assert.ok(imported);
  await commitPlan(
    await write("prepare_delete_transaction", { transactionId: imported.id }),
    "delete_transaction",
  );
  assert.ok(backupPath);
  await nav(page, "imports");
  await page.getByLabel("Restore a Tally JSON backup", { exact: true }).setInputFiles(backupPath);
  await page.getByRole("heading", { name: "Review", exact: true }).waitFor();
  await page.getByRole("button", { name: "Commit displayed preview", exact: true }).click();
  await page.getByRole("heading", { name: "Review", exact: true }).waitFor({ state: "hidden" });
  assert.equal(
    (await call("list_transactions", { currency: "INR", month: "2026-10" })).result.items.length,
    2,
  );
  assert.equal(
    (await call("get_investment_portfolio", { currency: "INR", asOf: "2026-10-14" })).result
      .valueMinor,
    51500,
  );
  result(
    "UI CSV upload/map/preview/commit, MCP reviewed-delete and JSON restore preserve investments",
  );

  await nav(page, "categories");
  await page.getByLabel("New category name", { exact: true }).fill("Synthetic audit category");
  await page.getByRole("button", { name: "Create category", exact: true }).click();
  await page.getByText("Synthetic audit category · expense", { exact: true }).waitFor();
  const cat = (
    await call("list_categories", { currency: "INR", includeArchived: true })
  ).result.categories.find((c) => c.name === "Synthetic audit category");
  await write("archive_category", { categoryId: cat.id });
  await write("restore_category", { categoryId: cat.id });
  await write("update_category", { categoryId: cat.id, name: "Synthetic reviewed category" });
  const exported = await write("export_accounting_backup");
  assert.ok(exported.fileId);
  await call("get_ai_status");
  const ai = (await call("get_ai_status")).result;
  assert.equal(ai.configured, false);
  const contextResult = await write("create_analysis_context", {
    month: "2026-10",
    question: "Synthetic: what is recorded spending?",
  });
  assert.ok(contextResult.contextId);
  result("UI category create; MCP category lifecycle, accounting export and disabled AI/context");

  // Render every section at narrow phone, phone, tablet, laptop and wide desktop sizes.
  const routes = [
    ["dashboard", root],
    ...[
      "accounts",
      "investments",
      "analysis",
      "statements",
      "ledger",
      "categories",
      "imports",
      "approvals",
      "chat",
      "tools",
    ].map((s) => [
      s,
      `http://127.0.0.1:9000/finance/agents?currency=INR&month=2026-10&section=${s}`,
    ]),
  ];
  report.viewports = [];
  for (const width of [320, 390, 768, 1280, 1440]) {
    const p = await context(true, width);
    try {
      for (const [name, url] of routes) {
        report.stage = `responsive:${width}:${name}`;
        await p.goto(url);
        await p.locator("h1").waitFor();
        if (name === "dashboard")
          await p
            .getByText(`Private server ledger · revision ${await revision()}`, { exact: true })
            .waitFor();
        else await p.getByText(/One private server workspace · revision/).waitFor();
        if (name === "analysis")
          await p.getByRole("heading", { name: "Bank and cash movement", exact: true }).waitFor();
        if (name === "accounts")
          await p.getByRole("heading", { name: "Synthetic education loan", exact: true }).waitFor();
        if (name === "investments")
          await p.getByRole("heading", { name: "Synthetic gold", exact: true }).waitFor();
        if (name === "chat")
          await p
            .getByText("Provider unconfigured. No financial data is sent.", { exact: true })
            .waitFor();
        await p.evaluate(() => document.fonts.ready);
        if (name === "dashboard") {
          const label = await p.getByLabel("Ledger currency", { exact: true }).evaluate((node) => {
            const style = getComputedStyle(node);
            const canvas = document.createElement("canvas");
            const context = canvas.getContext("2d");
            context.font = style.font;
            return {
              available:
                node.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
              text: context.measureText(node.selectedOptions[0].label).width,
            };
          });
          assert.ok(
            label.available >= label.text,
            `Clipped currency label at ${width}: ${JSON.stringify(label)}`,
          );
        }
        const clipped = await p
          .locator(
            "button:visible, input:visible, select:visible, h1:visible, h2:visible, h3:visible",
          )
          .evaluateAll((nodes) =>
            nodes
              .filter((n) => {
                const r = n.getBoundingClientRect();
                return r.left < -1 || r.right > innerWidth + 1;
              })
              .map((n) => ({ tag: n.tagName, text: n.textContent?.slice(0, 90) })),
          );
        assert.deepEqual(clipped, [], `Clipped controls at ${width}/${name}`);
        const dimensions = await p.evaluate(() => ({
          width: innerWidth,
          scroll: document.documentElement.scrollWidth,
        }));
        assert.ok(dimensions.scroll <= width, JSON.stringify({ width, name, dimensions }));
        assert.deepEqual(await p.evaluate(() => window.__tallyStorage), []);
        const inconsistentSelects = await p.locator("select.field:visible").evaluateAll((nodes) =>
          nodes
            .filter((node) => {
              const style = getComputedStyle(node);
              return (
                style.appearance !== "none" ||
                !style.backgroundImage.includes("data:image/svg+xml") ||
                Number.parseFloat(style.paddingRight) < 32
              );
            })
            .map((node) => node.getAttribute("aria-label") || node.name || node.id),
        );
        assert.deepEqual(
          inconsistentSelects,
          [],
          `Inconsistent dropdown arrows at ${width}/${name}`,
        );
        if (name === "accounts" && width >= 640) {
          const more = p.getByLabel("More workspace sections", { exact: true });
          await more.focus();
          await p.keyboard.press("Enter");
          const menu = more.locator("..");
          assert.equal(await menu.getAttribute("open"), "");
          const bounds = await menu.locator("div").boundingBox();
          assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width);
          assert.equal(await menu.getByRole("button").count(), 6);
          if (width === 1280) await p.screenshot({ path: "/qa-output/navigation-more-1280.png" });
          await p.keyboard.press("Escape");
          assert.equal(await menu.getAttribute("open"), null);
          await more.click();
          await menu.getByRole("button", { name: "Categories", exact: true }).click();
          await p.waitForURL(/section=categories/);
          assert.equal(await menu.getAttribute("open"), null);
          await nav(p, "accounts");
        }
        if ([390, 1280].includes(width)) {
          await p.screenshot({ path: `/qa-output/${name}-${width}.png`, fullPage: true });
          await p.screenshot({ path: `/qa-output/${name}-${width}-viewport.png` });
        }
        if (name === "dashboard" && width <= 390) {
          await p.getByRole("button", { name: "Add entry", exact: true }).click();
          const dialog = p.getByRole("dialog");
          await dialog.waitFor();
          await p.screenshot({ path: `/qa-output/entry-dialog-${width}.png` });
          const rect = await dialog.boundingBox();
          assert.ok(rect.x >= 0 && rect.x + rect.width <= width);
          await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
        }
        report.viewports.push({ width, section: name, overflow: false });
      }
    } catch (error) {
      report.responsiveFailure = {
        url: p.url(),
        text: await p
          .locator("body")
          .innerText()
          .catch(() => null),
      };
      await p
        .screenshot({ path: "/qa-output/responsive-failure.png", fullPage: true })
        .catch(() => {});
      throw error;
    } finally {
      await p.context().close();
    }
  }
  // Deep-link refresh/back semantics and keyboard focus use real navigation.
  await nav(mobile, "analysis");
  await mobile.getByRole("heading", { name: "Bank and cash movement", exact: true }).waitFor();
  assert.equal(await mobile.getByText("₹15.00", { exact: true }).count(), 1);
  await mobile.getByLabel("Workspace section", { exact: true }).selectOption("investments");
  await mobile.waitForURL(/section=investments/);
  assert.equal(new URL(mobile.url()).searchParams.get("section"), "investments");
  await mobile.reload();
  await mobile.getByRole("heading", { name: "Synthetic gold", exact: true }).waitFor();
  await mobile.goBack();
  await mobile.getByLabel("Workspace section", { exact: true }).selectOption("analysis");
  await mobile.getByRole("heading", { name: "Bank and cash movement", exact: true }).waitFor();
  await mobile.keyboard.press("Tab");
  assert.ok(await mobile.evaluate(() => document.activeElement !== document.body));
  result("55 responsive renders, analysis/MCP parity, deep links, reload and keyboard focus");
  assert.ok(cardId);
  assert.ok((await readFile("/qa-output/dashboard-390.png")).length > 1000);
}
