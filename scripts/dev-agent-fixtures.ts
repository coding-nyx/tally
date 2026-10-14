import { spawn } from "node:child_process";
import { syntheticEnvironment } from "../src/lib/agent-tools/test-fixtures.ts";
console.log(
  "Starting loopback-only Tally with synthetic QA records and a local provider stub. No real AI requests.",
);
const child = spawn("npm", ["run", "dev"], {
  stdio: "inherit",
  env: {
    ...process.env,
    ...syntheticEnvironment(),
    TALLY_AGENT_SYNTHETIC_QA: "true",
    TALLY_AI_KEYCHAIN_ENABLED: "false",
    TALLY_AI_PROVIDER: "",
    TALLY_AI_API_KEY: "",
    TMPDIR: "/tmp",
  },
});
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => child.kill(signal));
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
