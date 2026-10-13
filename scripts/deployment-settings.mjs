/** Explicit build targets; normal preview and Vercel builds keep their defaults. */
export function deploymentSettings(environment = process.env) {
  const target = environment.TALLY_DEPLOY_TARGET || "vercel";
  if (!["vercel", "node"].includes(target)) throw new Error("Unsupported Tally deployment target.");
  const base = environment.TALLY_BASE_PATH || "/";
  if (!/^\/(?:[a-zA-Z0-9_-]+\/)*$/.test(base)) {
    throw new Error("TALLY_BASE_PATH must be an absolute path with a trailing slash.");
  }
  return { base, preset: target === "node" ? "node_server" : "vercel" };
}
