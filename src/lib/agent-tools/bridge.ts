import { McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import { z } from "zod";
import { catalog } from "./catalog.ts";

export function bridgeConfiguration(env: Record<string, string | undefined>) {
  const base = new URL(env.TALLY_URL ?? "");
  if (
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    (base.protocol !== "https:" &&
      !(base.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname)))
  )
    throw new Error(
      "TALLY_URL must be an HTTPS app URL or a loopback test URL, without credentials/query/fragment.",
    );
  if (!env.TALLY_ACCESS_TOKEN || !/^[^\s]{32,512}$/.test(env.TALLY_ACCESS_TOKEN))
    throw new Error("A protected TALLY_ACCESS_TOKEN is required.");
  if (!base.pathname.endsWith("/")) base.pathname += "/";
  return { base, token: env.TALLY_ACCESS_TOKEN };
}
export async function createTallyMcpServer(env = process.env, fetcher: typeof fetch = fetch) {
  const config = bridgeConfiguration(env);
  const request = async (path: string, init?: RequestInit) => {
    const response = await fetcher(new URL(path, config.base), {
      ...init,
      redirect: "error",
      signal: init?.signal ?? AbortSignal.timeout(20000),
      headers: { ...init?.headers, authorization: `Bearer ${config.token}` },
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => undefined)) as
        { error?: { code?: string; message?: string } } | undefined;
      throw new Error(
        `${body?.error?.code ?? "unavailable"}: ${body?.error?.message ?? "The Tally service could not handle the request."}`,
      );
    }
    return response;
  };
  const discovered = (await (await request("api/agent")).json()) as {
    version: number;
    tools: Array<{ name: string }>;
  };
  if (discovered.version !== 2 || !Array.isArray(discovered.tools))
    throw new Error("Tally tool service version 2 is required.");
  const permitted = new Set(discovered.tools.map((t) => t.name));
  const server = new McpServer({ name: "tally", version: "2.0.0" });
  for (const [name, definition] of Object.entries(catalog)) {
    if (!permitted.has(name)) continue;
    const inputSchema =
      definition.effect === "read"
        ? definition.schema
        : definition.schema.extend({ idempotencyKey: z.string().min(8).max(128) });
    server.registerTool(
      name,
      {
        description: definition.description,
        inputSchema,
        annotations: {
          readOnlyHint: definition.effect === "read",
          destructiveHint: definition.effect === "write",
          idempotentHint: true,
          openWorldHint: definition.effect === "external",
        },
      },
      async (input, context) => {
        const { idempotencyKey, ...args } = input as Record<string, unknown>;
        try {
          const result = (await (
            await request("api/agent", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                version: 2,
                tool: name,
                args,
                ...(idempotencyKey ? { idempotencyKey } : {}),
              }),
              signal: AbortSignal.any([context.mcpReq.signal, AbortSignal.timeout(20000)]),
            })
          ).json()) as Record<string, unknown>;
          return {
            content: [{ type: "text", text: JSON.stringify(result) }],
            structuredContent: result,
          };
        } catch (e) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text:
                  e instanceof Error
                    ? e.message
                    : "Tally request failed. Reuse the same key when retrying.",
              },
            ],
          };
        }
      },
    );
  }
  if (permitted.has("tally_get_file"))
    server.registerResource(
      "tally-private-file",
      new ResourceTemplate("tally-file://{currency}/{fileId}", { list: undefined }),
      {
        description: "An owned, expiring export. Get its id from a Tally export tool.",
        mimeType: "application/octet-stream",
      },
      async (uri, variables) => {
        const currency = z.enum(["INR", "USD"]).parse(variables.currency);
        const fileId = z
          .string()
          .regex(/^[a-f0-9-]{36}$/)
          .parse(variables.fileId);
        const response = await request(`api/agent/files/${fileId}?currency=${currency}`);
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: response.headers.get("content-type") ?? "application/octet-stream",
              blob: Buffer.from(await response.arrayBuffer()).toString("base64"),
            },
          ],
        };
      },
    );
  return server;
}
