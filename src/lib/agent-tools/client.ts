/** Browser credentials stay in memory. The server always decides authorization. */
export class TallyClientError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
export function agentBaseUrl(location: Pick<Location, "origin" | "pathname">) {
  const path = location.pathname.replace(/\/agents\/?$/, "/");
  return new URL(
    "api/agent",
    `${location.origin}${path.endsWith("/") ? path : `${path}/`}`,
  ).toString();
}
export type TallyDiscovery = {
  version: 2;
  authMode: "tailnet" | "bearer";
  storageConfigured: boolean;
  tools: Array<{ name: string; effect: string; [key: string]: unknown }>;
};
export class TallyClient {
  private endpoint: string;
  private token: string;
  constructor(endpoint: string, token = "") {
    this.endpoint = endpoint;
    this.token = token;
  }
  async request(path: string, init?: RequestInit) {
    const response = await fetch(`${this.endpoint}${path}`, {
      ...init,
      redirect: "error",
      headers: {
        ...init?.headers,
        "x-tally-request": "1",
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
    });
    if (!response.ok) {
      const value = (await response.json().catch(() => ({}))) as {
        error?: { code?: string; message?: string };
      };
      throw new TallyClientError(
        value.error?.code ?? "unavailable",
        value.error?.message ??
          "Tally is unavailable. Retry the same request after checking its receipt.",
        response.status,
      );
    }
    return response;
  }
  async discover(signal?: AbortSignal): Promise<TallyDiscovery> {
    const response = await this.request("", { signal });
    const value = await response.json().catch(() => null);
    if (
      value?.version !== 2 ||
      !["tailnet", "bearer"].includes(value.authMode) ||
      typeof value.storageConfigured !== "boolean" ||
      !Array.isArray(value.tools) ||
      !value.tools.every(
        (tool: TallyDiscovery["tools"][number] | null) =>
          tool && typeof tool.name === "string" && typeof tool.effect === "string",
      )
    )
      throw new TallyClientError(
        "invalid_response",
        "The Tally service returned invalid discovery data.",
        502,
      );
    if (!value.storageConfigured)
      throw new TallyClientError(
        "storage_unconfigured",
        "Tool access is enabled, but shared ledger storage is not configured.",
        503,
      );
    return value;
  }
  async call(
    tool: string,
    args: Record<string, unknown>,
    idempotencyKey?: string,
    signal?: AbortSignal,
  ) {
    const response = await this.request("", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: 2,
        tool,
        args,
        ...(idempotencyKey ? { idempotencyKey } : {}),
      }),
      signal,
    });
    const body = await response.json();
    if (!body.ok) throw new Error(body.error?.message ?? "Tally operation failed.");
    return body.result as Record<string, any>;
  }
  async upload(currency: string, file: File, signal?: AbortSignal) {
    const mime = file.name.endsWith(".csv")
      ? "text/csv"
      : file.name.endsWith(".pdf")
        ? "application/pdf"
        : file.name.endsWith(".json")
          ? "application/json"
          : "text/plain";
    const response = await this.request(`/files?currency=${currency}`, {
      method: "POST",
      headers: { "content-type": mime, "x-file-name": file.name.replace(/[^a-zA-Z0-9._-]/g, "_") },
      body: file,
      signal,
    });
    return (await response.json()).result as Record<string, any>;
  }
  async download(currency: string, fileId: string) {
    const response = await this.request(`/files/${fileId}?currency=${currency}`);
    const blob = await response.blob();
    const link = document.createElement("a");
    const url = URL.createObjectURL(blob);
    link.href = url;
    link.download =
      response.headers.get("content-disposition")?.match(/filename="([^"]+)"/)?.[1] ??
      "tally-export";
    link.click();
    URL.revokeObjectURL(url);
  }
}
