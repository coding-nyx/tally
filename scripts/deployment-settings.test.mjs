import test from "node:test";
import assert from "node:assert/strict";
import { deploymentSettings } from "./deployment-settings.mjs";
import { injectGrokPwaHead, renderWebManifest, renderInstallPageHtml } from "./grok-pwa-shared.mjs";

test("normal builds keep root routing and Vercel", () => {
  assert.deepEqual(deploymentSettings({}), { base: "/", preset: "vercel" });
});
test("hub builds use a standalone server and finance prefix", () => {
  assert.deepEqual(deploymentSettings({ TALLY_DEPLOY_TARGET: "node", TALLY_BASE_PATH: "/finance/" }), { base: "/finance/", preset: "node_server" });
});
test("deployment settings reject malformed prefixes and unknown runtimes", () => {
  for (const path of ["finance", "/finance", "//host/", "/../", "/x?y/"]) {
    assert.throws(() => deploymentSettings({ TALLY_BASE_PATH: path }));
  }
  assert.throws(() => deploymentSettings({ TALLY_DEPLOY_TARGET: "unknown" }));
});
test("finance manifest stays within the finance application", () => {
  const manifest = JSON.parse(renderWebManifest("hub.example.ts.net", { basePath: "/finance/", appName: "Tally" }));
  assert.equal(manifest.name, "Tally");
  for (const key of ["id", "start_url", "scope"]) assert.equal(manifest[key], "/finance/");
  assert.equal(manifest.icons[0].src, "/finance/__grok/icon-180.png");
});
test("finance head preserves branding and prefixes PWA URLs", () => {
  const html = injectGrokPwaHead('<html><head><title>Tally</title><link rel="manifest" href="/finance/__grok/manifest.webmanifest"></head><body>Tally</body></html>', { basePath: "/finance/", cwd: "/nonexistent", site: { title: "Tally" } });
  assert.equal((html.match(/rel="manifest"/g) || []).length, 1);
  assert.match(html, /href="\/finance\/__grok\/icon-180.png"/);
  assert.match(html, /grok-app-builder\/extensions.js/);
  assert.doesNotMatch(html, /href="\/__grok\//);
  assert.match(renderInstallPageHtml('<link href="/__grok/install/styles.css"><a href="{{APP_URL}}">App</a>', { url: "/finance/?install=1&platform=ios", basePath: "/finance/" }), /href="\/finance\//);
});
