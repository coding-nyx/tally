import assert from "node:assert/strict";
import test from "node:test";
import { runtimeSecrets } from "./start-tally.mjs";
test("runtime secret files are opt-in, bounded and never expose paths or values in failures", async () => {
  assert.deepEqual(
    await runtimeSecrets({ NODE_ENV: "production" }, async () => {
      throw new Error("Unexpected read");
    }),
    { NODE_ENV: "production" },
  );
  const env = await runtimeSecrets(
    { TALLY_AGENT_GRANTS_JSON_FILE: "/synthetic/selected-file" },
    async () => " synthetic-test-value \n",
  );
  assert.equal(env.TALLY_AGENT_GRANTS_JSON, "synthetic-test-value");
  await assert.rejects(
    runtimeSecrets({ TALLY_AI_API_KEY: "synthetic", TALLY_AI_API_KEY_FILE: "/synthetic" }),
    /never both/,
  );
  await assert.rejects(
    runtimeSecrets({ TALLY_AI_API_KEY_FILE: "/PRIVATE-path" }, async () => {
      throw new Error("SECRET value");
    }),
    (e) => !e.message.includes("PRIVATE") && !e.message.includes("SECRET"),
  );
  await assert.rejects(
    runtimeSecrets({ TALLY_AI_API_KEY_FILE: "/synthetic" }, async () => "x".repeat(1048577)),
    /oversized/,
  );
});
