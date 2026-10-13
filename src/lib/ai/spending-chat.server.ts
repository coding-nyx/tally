import { spendingChatConfig, validateSpendingChatRequest } from "./spending-chat.ts";

const CHAT_TIMEOUT_MS = 15_000;

export function spendingChatServerAvailability() {
  return spendingChatConfig(process.env) !== null;
}

export async function answerSpendingQuestion(
  input: unknown,
  requestSignal?: AbortSignal,
  environment: Record<string, string | undefined> = process.env,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  const config = spendingChatConfig(environment);
  if (!config) throw new Error("Chat is not configured yet.");
  const parsed = validateSpendingChatRequest(input);
  if (!parsed) throw new Error("The question or spending summary is invalid. Review it and try again.");

  const timeout = AbortSignal.timeout(CHAT_TIMEOUT_MS);
  const signal = requestSignal ? AbortSignal.any([requestSignal, timeout]) : timeout;
  const response = await fetcher(config.endpoint, {
    method: "POST",
    signal,
    headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: config.model,
      max_tokens: 500,
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content: "You are Tally, a practical personal budgeting helper. Answer only from the supplied monthly aggregate summary. Do not infer transaction details, identity, or financial facts not present. Be concise, avoid investment/tax advice, and state when the summary is insufficient.",
        },
        {
          role: "user",
          content: JSON.stringify({ question: parsed.question, monthlySummary: parsed.summary }),
        },
      ],
    }),
  });
  if (!response.ok) throw new Error(response.status === 429
    ? "The AI provider is busy or rate limited. Wait a moment, then retry."
    : "The AI provider could not answer right now. Check its server configuration and retry.");
  const payload: unknown = await response.json();
  if (!payload || typeof payload !== "object") throw new Error("The AI provider returned an unreadable response. Retry.");
  const choices = (payload as { choices?: unknown }).choices;
  const content = Array.isArray(choices) ? (choices[0] as { message?: { content?: unknown } } | undefined)?.message?.content : null;
  if (typeof content !== "string" || !content.trim()) throw new Error("The AI provider returned an empty response. Retry.");
  return content.trim().slice(0, 4_000);
}
