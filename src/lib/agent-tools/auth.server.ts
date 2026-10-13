import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { scopes } from "./catalog.ts";
import { ToolError } from "./service.ts";
import type { Principal } from "./store.ts";
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
    new URL(request.url).origin !== canonical ||
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
