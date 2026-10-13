import test from "node:test";
import assert from "node:assert/strict";
import { localProviderEnvironment } from "./with-keychain-provider.mjs";

test("macOS loads only the named DeepSeek item into child environment", () => {
  let reads = 0;
  const env = localProviderEnvironment({ PATH: "/bin", TALLY_AI_KEYCHAIN_ENABLED: "true" }, {
    platform: "darwin",
    readKeychain: () => { reads += 1; return "  synthetic-key  "; },
  });
  assert.equal(reads, 1);
  assert.equal(env.TALLY_AI_PROVIDER, "deepseek");
  assert.equal(env.TALLY_AI_MODEL, "deepseek-flash");
  assert.equal(env.TALLY_AI_API_KEY, "synthetic-key");
  assert.equal(env.PATH, "/bin");
});

test("missing keychain item leaves chat unconfigured", () => {
  const env = localProviderEnvironment({ TALLY_AI_KEYCHAIN_ENABLED: "true" }, { platform: "darwin", readKeychain: () => "" });
  assert.equal(env.TALLY_AI_PROVIDER, "deepseek");
  assert.equal(env.TALLY_AI_API_KEY, undefined);
});

test("explicit environment key and non-DeepSeek provider avoid keychain lookup", () => {
  let reads = 0;
  const explicit = localProviderEnvironment({ TALLY_AI_API_KEY: "env-key", TALLY_AI_KEYCHAIN_ENABLED: "true" }, {
    platform: "darwin", readKeychain: () => { reads += 1; return "unexpected"; },
  });
  assert.equal(explicit.TALLY_AI_API_KEY, "env-key");
  assert.equal(reads, 0);
  const compatible = localProviderEnvironment({ TALLY_AI_PROVIDER: "openai-compatible", TALLY_AI_KEYCHAIN_ENABLED: "true" }, {
    platform: "darwin", readKeychain: () => { reads += 1; return "unexpected"; },
  });
  assert.equal(compatible.TALLY_AI_PROVIDER, "openai-compatible");
  assert.equal(compatible.TALLY_AI_API_KEY, undefined);
  assert.equal(reads, 0);
});

test("other platforms never read macOS Keychain", () => {
  let reads = 0;
  const input = { TALLY_AI_PROVIDER: "unset", KEEP: "yes" };
  const env = localProviderEnvironment(input, {
    platform: "linux", readKeychain: () => { reads += 1; return "unexpected"; },
  });
  assert.deepEqual(env, input);
  assert.notEqual(env, input);
  assert.equal(reads, 0);
});

test("macOS Keychain is not inspected without explicit opt-in", () => {
  let reads = 0;
  const env = localProviderEnvironment({}, {
    platform: "darwin", readKeychain: () => { reads += 1; return "unexpected"; },
  });
  assert.deepEqual(env, {});
  assert.equal(reads, 0);
});
