import { createHash } from "node:crypto";
import { scopes } from "./catalog.ts";
/** Deliberately public synthetic values: never production credentials. */
export const SYNTHETIC_AGENT_TOKEN = "synthetic-agent-fixture-token-not-a-real-credential";
export const SYNTHETIC_OWNER_TOKEN = "synthetic-owner-fixture-token-not-a-real-credential";
export function syntheticEnvironment(origin = "http://127.0.0.1:8080") {
  const grant = (token: string, actorId: string, role: "owner" | "agent", permitted: string[]) => ({
    tokenSha256: createHash("sha256").update(token).digest("hex"),
    ownerId: "synthetic-owner",
    actorId,
    role,
    currencies: ["INR", "USD"],
    scopes: permitted,
    expiresAt: Date.now() + 3600000,
  });
  return {
    TALLY_AGENT_ENABLED: "true",
    TALLY_AGENT_DATABASE_URL: "postgresql://synthetic.invalid/fixtures",
    TALLY_AGENT_PUBLIC_ORIGIN: origin,
    TALLY_AGENT_GRANTS_JSON: JSON.stringify([
      grant(
        SYNTHETIC_AGENT_TOKEN,
        "synthetic-agent",
        "agent",
        scopes.filter((s) => s !== "owner:approve"),
      ),
      grant(SYNTHETIC_OWNER_TOKEN, "synthetic-human", "owner", scopes),
    ]),
  };
}
