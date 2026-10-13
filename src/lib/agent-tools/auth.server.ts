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
    !env.TALLY_AGENT_DATABASE_URL?.trim() ||
    !env.TALLY_AGENT_PUBLIC_ORIGIN ||
    !env.TALLY_AGENT_GRANTS_JSON
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
    const grants = z
      .array(grantSchema)
      .min(1)
      .max(100)
      .parse(JSON.parse(env.TALLY_AGENT_GRANTS_JSON));
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
