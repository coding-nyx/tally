import { execFileSync, spawn } from "node:child_process";
import { constants as osConstants } from "node:os";
import { fileURLToPath } from "node:url";

export const DEEPSEEK_KEYCHAIN_SERVICE = "com.tally.deepseek";
export const DEEPSEEK_KEYCHAIN_ACCOUNT = "TALLY_AI_API_KEY";

/** Read only the explicitly named Tally keychain item after opt-in; never print its value. */
export function localProviderEnvironment(environment, { platform = process.platform, readKeychain = readDeepSeekKeychain } = {}) {
  if (platform !== "darwin" || environment.TALLY_AI_KEYCHAIN_ENABLED !== "true") return { ...environment };
  const providerEnvironment = {
    ...environment,
    TALLY_AI_PROVIDER: environment.TALLY_AI_PROVIDER || "deepseek",
    TALLY_AI_MODEL: environment.TALLY_AI_MODEL || "deepseek-flash",
  };
  if (providerEnvironment.TALLY_AI_PROVIDER !== "deepseek" || providerEnvironment.TALLY_AI_API_KEY?.trim()) {
    return providerEnvironment;
  }
  const key = readKeychain();
  if (key?.trim()) providerEnvironment.TALLY_AI_API_KEY = key.trim();
  return providerEnvironment;
}

function readDeepSeekKeychain() {
  try {
    return execFileSync("/usr/bin/security", [
      "find-generic-password",
      "-s", DEEPSEEK_KEYCHAIN_SERVICE,
      "-a", DEEPSEEK_KEYCHAIN_ACCOUNT,
      "-w",
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2_000 });
  } catch {
    return "";
  }
}

function main(argv) {
  const separator = argv.indexOf("--");
  const command = separator >= 0 ? argv.slice(separator + 1) : argv;
  if (!command.length) {
    console.error("usage: node scripts/with-keychain-provider.mjs -- <command> [args…]");
    process.exit(2);
  }
  const child = spawn(command[0], command.slice(1), {
    stdio: "inherit",
    env: localProviderEnvironment(process.env),
  });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => child.kill(signal));
  child.on("error", (error) => {
    console.error(`[keychain-provider] failed to run ${command[0]}:`, error?.message || error);
    process.exit(127);
  });
  child.on("exit", (code, signal) => {
    const signo = signal ? osConstants.signals[signal] : undefined;
    process.exit(signal ? 128 + (typeof signo === "number" ? signo : 1) : code ?? 1);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
