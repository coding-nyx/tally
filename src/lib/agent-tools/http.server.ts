import { z } from "zod";
import { catalog, currency } from "./catalog.ts";
import { AgentToolService, ToolError } from "./service.ts";
import { authenticate } from "./auth.server.ts";
import { configuredStore } from "./store.server.ts";
let service: AgentToolService | undefined;
async function configuredService() {
  if (!service && import.meta.env?.DEV && process.env.TALLY_AGENT_SYNTHETIC_QA === "true") {
    const { syntheticQaService } = await import("./fixtures.server.ts");
    service = await syntheticQaService();
  }
  service ??= new AgentToolService(configuredStore(), process.env);
  return service;
}
export async function readBounded(request: Request, max: number) {
  const length = request.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > max))
    throw new ToolError("too_large", "Request exceeds its size limit.", 413);
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let count = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      count += value.byteLength;
      if (count > max) {
        await reader.cancel();
        throw new ToolError("too_large", "Request exceeds its size limit.", 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}
export async function handleAgentRequest(
  request: Request,
  suppliedService?: AgentToolService,
  env = process.env,
) {
  const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
  const json = (body: unknown, status = 200) => Response.json(body, { status, headers });
  try {
    const principal = authenticate(request, env);
    const engine = suppliedService ?? (await configuredService());
    const url = new URL(request.url);
    const suffix = url.pathname
      .slice(url.pathname.indexOf("/api/agent") + 10)
      .replace(/^\/+|\/+$/g, "");
    if (!suffix && request.method === "GET") {
      return json({
        version: 2,
        tools: Object.entries(catalog)
          .filter(([, tool]) => principal.scopes.includes(tool.scope))
          .map(([name, tool]) => ({
            name,
            description: tool.description,
            scope: tool.scope,
            effect: tool.effect,
            inputSchema: z.toJSONSchema(tool.schema, { unrepresentable: "any" }),
          })),
      });
    }
    if (!suffix && request.method === "POST") {
      if (!request.headers.get("content-type")?.startsWith("application/json"))
        throw new ToolError("content_type", "Use application/json.", 415);
      let input: unknown;
      try {
        input = JSON.parse((await readBounded(request, 16384)).toString("utf8"));
      } catch (e) {
        if (e instanceof ToolError) throw e;
        throw new ToolError("invalid_json", "Invalid JSON request.");
      }
      return json(await engine.execute(principal, input));
    }
    if (suffix === "files" && request.method === "POST") {
      const selected = currency.parse(url.searchParams.get("currency"));
      const bytes = await readBounded(request, 10485760);
      return json(
        {
          ok: true,
          result: await engine.upload(
            principal,
            selected,
            request.headers.get("x-file-name") ?? "statement",
            (request.headers.get("content-type") ?? "").split(";")[0],
            bytes,
          ),
        },
        201,
      );
    }
    if (/^files\/[^/]+$/.test(suffix) && request.method === "GET") {
      const file = await engine.download(
        principal,
        currency.parse(url.searchParams.get("currency")),
        suffix.slice(6),
      );
      return new Response(new Uint8Array(file.bytes), {
        headers: {
          ...headers,
          "content-type": file.mime,
          "content-disposition": `attachment; filename="${file.name}"`,
        },
      });
    }
    if (suffix === "approvals" && request.method === "GET")
      return json({ ok: true, result: { approvals: await engine.approvals(principal) } });
    if (suffix === "approval-rows" && request.method === "GET")
      return json({
        ok: true,
        result: await engine.approvalRows(
          principal,
          z.string().min(1).max(128).parse(url.searchParams.get("approvalId")),
          url.searchParams.get("cursor") ?? undefined,
        ),
      });
    if (suffix === "approvals" && request.method === "POST") {
      let value: unknown;
      try {
        value = JSON.parse((await readBounded(request, 16384)).toString());
      } catch (e) {
        if (e instanceof ToolError) throw e;
        throw new ToolError("invalid_json", "Invalid JSON request.");
      }
      const input = z
        .strictObject({
          approvalId: z.string().min(1).max(128),
          previewHash: z.string().regex(/^[a-f0-9]{64}$/),
          approve: z.boolean(),
        })
        .parse(value);
      return json({
        ok: true,
        result: await engine.decide(principal, input.approvalId, input.previewHash, input.approve),
      });
    }
    return json(
      { ok: false, error: { code: "not_found", message: "Agent endpoint not found." } },
      404,
    );
  } catch (error) {
    if (error instanceof ToolError)
      return json({ ok: false, error: { code: error.code, message: error.message } }, error.status);
    if (error instanceof z.ZodError)
      return json(
        {
          ok: false,
          error: {
            code: "invalid_args",
            message: "The request or stored ledger failed validation.",
          },
        },
        400,
      );
    // Database/provider exceptions can contain credentials, SQL or data. Never return or log them.
    return json(
      {
        ok: false,
        error: {
          code: "unavailable",
          message:
            "The shared ledger is unavailable. Check owner setup and retry using the same idempotency key.",
        },
      },
      503,
    );
  }
}
