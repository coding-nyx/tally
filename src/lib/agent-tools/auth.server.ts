import { createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { z } from "zod";
import { scopes } from "./catalog.ts";
import { ToolError } from "./service.ts";
import type { Principal } from "./store.ts";
function trustedProxyAddresses(env: Record<string, string | undefined>) {
  const source = env.TALLY_AGENT_TRUSTED_PROXY_IPS?.trim();
  if (!source) return [];
  const addresses = source.split(",").map((s) => s.trim());
  if (addresses.length > 8 || addresses.some((s) => !isIP(s)))
    throw new Error("Invalid trusted proxy addresses");
  return addresses;
}
function requestOrigin(request: Request, env: Record<string, string | undefined>) {
  const actual = new URL(request.url).origin;
  if (actual === env.TALLY_AGENT_PUBLIC_ORIGIN) return actual;
  // srvx supplies this from the accepted socket when proxy trust is disabled.
  // A client-sent X-Forwarded-For header is never used as this trust decision.
  const socketIp = (request as Request & { ip?: unknown }).ip;
  if (typeof socketIp !== "string") return actual;
  const normalized = socketIp.startsWith("::ffff:") ? socketIp.slice(7) : socketIp;
  if (!trustedProxyAddresses(env).includes(normalized)) return actual;
  const proto = request.headers.get("x-forwarded-proto");
  const host = request.headers.get("x-forwarded-host");
  const canonical = new URL(env.TALLY_AGENT_PUBLIC_ORIGIN!);
  // Accept only one exact canonical host/protocol, never a comma-separated chain.
  if (proto !== canonical.protocol.slice(0, -1) || host !== canonical.host) return actual;
  return canonical.origin;
}
function tailnetMode(env: Record<string, string | undefined>) {
  return env.TALLY_AGENT_AUTH_MODE === "tailnet";
}
function authenticateTailnet(request: Request, env: Record<string, string | undefined>): Principal {
  const socket = (request as Request & { ip?: unknown }).ip;
  const ip = typeof socket === "string" ? socket.replace(/^::ffff:/, "") : "";
  const canonical = new URL(env.TALLY_AGENT_PUBLIC_ORIGIN!);
  // Serve overwrites XFF with the actual tailnet source. Caddy then appends
  // its accepted loopback peer. Neither a client identity header nor a prefix
  // in an arbitrary forwarded chain establishes trust.
  const chain = (request.headers.get("x-forwarded-for") ?? "").split(",").map((s) => s.trim());
  const peer = chain[0];
  const tailnetAddress =
    isIP(peer) === 4
      ? peer.split(".")[0] === "100" &&
        Number(peer.split(".")[1]) >= 64 &&
        Number(peer.split(".")[1]) <= 127
      : isIP(peer) === 6 && peer.toLowerCase().startsWith("fd7a:115c:a1e0:");
  if (
    !trustedProxyAddresses(env).includes(ip) ||
    chain.length !== 2 ||
    !["127.0.0.1", "::1"].includes(chain[1]) ||
    !tailnetAddress ||
    request.headers.has("tailscale-funnel-request") ||
    request.headers.get("x-forwarded-host") !== canonical.host ||
    request.headers.get("x-forwarded-proto") !== "https"
  )
    throw new ToolError("private_route_required", "Use the private Tailscale Serve URL.", 403);
  if (
    request.headers.get("sec-fetch-site") === "cross-site" ||
    (!["GET", "HEAD"].includes(request.method) && request.headers.get("x-tally-request") !== "1")
  )
    throw new ToolError(
      "invalid_origin",
      "Use the Tally app or tool client for this request.",
      403,
    );
  // The user selected unrestricted shared access within this private route.
  // This is one shared principal, not independent authenticated agent identities.
  return {
    ownerId: env.TALLY_AGENT_WORKSPACE_ID!,
    actorId: "tailnet-shared",
    role: "owner",
    currencies: ["INR", "USD"],
    scopes: [...scopes],
    expiresAt: Number.MAX_SAFE_INTEGER,
  };
}
const grantSchema = z
  .strictObject({
    tokenSha256: z.string().regex(/^[a-f0-9]{64}$/),
    ownerId: z.string().min(1).max(128),
    actorId: z.string().min(1).max(128),
    role: z.enum(["owner", "agent"]),
    currencies: z
      .array(z.enum(["INR", "USD"]))
      .min(1)
      .max(2),
    scopes: z
      .array(z.string().refine((s) => scopes.includes(s)))
      .min(1)
      .max(scopes.length),
    expiresAt: z.number().int().positive(),
  })
  .refine(
    (g) => g.role === "owner" || !g.scopes.includes("owner:approve"),
    "Agents cannot have owner approval scope",
  );
export function agentConfigurationReady(env: Record<string, string | undefined> = process.env) {
  if (
    env.TALLY_AGENT_ENABLED !== "true" ||
    !env.TALLY_AGENT_PUBLIC_ORIGIN ||
    (!tailnetMode(env) && (!env.TALLY_AGENT_DATABASE_URL?.trim() || !env.TALLY_AGENT_GRANTS_JSON))
  )
    return false;
  try {
    trustedProxyAddresses(env);
    const origin = new URL(env.TALLY_AGENT_PUBLIC_ORIGIN);
    if (
      origin.origin !== env.TALLY_AGENT_PUBLIC_ORIGIN ||
      origin.username ||
      origin.password ||
      (origin.protocol !== "https:" &&
        !(
          origin.protocol === "http:" &&
          ["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname)
        ))
    )
      return false;
    if (tailnetMode(env))
      return (
        origin.protocol === "https:" &&
        origin.hostname.endsWith(".ts.net") &&
        trustedProxyAddresses(env).length > 0 &&
        /^[a-zA-Z0-9_-]{1,128}$/.test(env.TALLY_AGENT_WORKSPACE_ID ?? "")
      );
    if (env.TALLY_AGENT_AUTH_MODE && env.TALLY_AGENT_AUTH_MODE !== "bearer") return false;
    const grants = z
      .array(grantSchema)
      .min(1)
      .max(100)
      .parse(JSON.parse(env.TALLY_AGENT_GRANTS_JSON!));
    return (
      new Set(grants.map((g) => g.actorId)).size === grants.length &&
      new Set(grants.map((g) => g.tokenSha256)).size === grants.length
    );
  } catch {
    return false;
  }
}
export function authenticate(
  request: Request,
  env: Record<string, string | undefined> = process.env,
): Principal {
  if (!agentConfigurationReady(env))
    throw new ToolError("disabled", "Shared ledger and agent tools are not configured.", 503);
  const canonical = env.TALLY_AGENT_PUBLIC_ORIGIN!;
  if (
    requestOrigin(request, env) !== canonical ||
    (request.headers.has("origin") && request.headers.get("origin") !== canonical)
  )
    throw new ToolError("invalid_origin", "This request origin is not allowed.", 403);
  if (tailnetMode(env)) return authenticateTailnet(request, env);
  const header = request.headers.get("authorization") ?? "";
  if (!/^Bearer [^\s]{32,512}$/.test(header))
    throw new ToolError("unauthorized", "Provide a valid scoped access grant.", 401);
  const digest = createHash("sha256").update(header.slice(7)).digest();
  const grants = z.array(grantSchema).parse(JSON.parse(env.TALLY_AGENT_GRANTS_JSON!));
  const grant = grants.find((g) => timingSafeEqual(Buffer.from(g.tokenSha256, "hex"), digest));
  if (!grant || grant.expiresAt <= Date.now())
    throw new ToolError("unauthorized", "The access grant is missing, expired or revoked.", 401);
  const { tokenSha256: _digest, ...principal } = grant;
  return principal;
}
