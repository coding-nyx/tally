import { useEffect, useRef, useState, type FormEvent } from "react";
import { Bot, LoaderCircle, Send, Square } from "lucide-react";
import { buildSpendingSummary, type SpendingChatAvailability, type SpendingSummary } from "@/lib/ai/spending-chat";
import { askSpendingQuestion, getSpendingChatStatus } from "@/lib/ai/spending-chat-functions";
import type { BudgetData } from "@/lib/budget";

type ChatLine = { role: "you" | "tally"; text: string };

export function SpendingChatPanel({ data, month }: { data: BudgetData; month: string }) {
  const [availability, setAvailability] = useState<SpendingChatAvailability>({
    state: "unconfigured",
    message: "Checking the server-side AI provider…",
  });
  const [question, setQuestion] = useState("");
  const [consent, setConsent] = useState(false);
  const [lines, setLines] = useState<ChatLine[]>([]);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const summary: SpendingSummary = buildSpendingSummary(data, month);

  useEffect(() => {
    let active = true;
    void getSpendingChatStatus()
      .then((result) => {
        return result.configured === true
          ? { state: "ready", message: "A provider is configured. Review the sharing notice before each question." } as SpendingChatAvailability
          : { state: "unconfigured", message: "No AI provider is configured. Chat is disabled and no financial data is being sent." } as SpendingChatAvailability;
      })
      .then((result) => { if (active) setAvailability(result); })
      .catch(() => { if (active) setAvailability({ state: "unconfigured", message: "Provider status could not be checked. Chat stays disabled." }); });
    return () => {
      active = false;
      controller.current?.abort();
    };
  }, []);

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const prompt = question.trim();
    if (!prompt || prompt.length > 500 || !consent || availability.state !== "ready" || pending) return;
    setPending(true);
    setError("");
    const abort = new AbortController();
    controller.current = abort;
    setLines((current) => [...current, { role: "you", text: prompt }]);
    setQuestion("");
    try {
      const result = await askSpendingQuestion({
        data: { question: prompt, summary },
        signal: abort.signal,
      });
      if (!result.answer) throw new Error("Tally could not get an answer. Retry.");
      setLines((current) => [...current, { role: "tally", text: result.answer }]);
    } catch (failure) {
      setQuestion(prompt);
      if (!abort.signal.aborted) {
        setError(failure instanceof Error ? failure.message : "The request failed. Retry when ready.");
      }
      setLines((current) => current.filter((line, index) => !(line.role === "you" && index === current.length - 1 && line.text === prompt)));
    } finally {
      if (controller.current === abort) controller.current = null;
      setPending(false);
    }
  }

  return (
    <section className="panel" aria-labelledby="spending-chat-heading">
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-track text-accent" aria-hidden="true">
          <Bot className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="spending-chat-heading" className="text-lg font-medium">Spending chat</h2>
            <span role="status" className="rounded-full bg-track px-2.5 py-1 text-xs font-medium text-muted">
              {availability.state === "ready" ? "Provider ready" : "AI not configured"}
            </span>
          </div>
          <p className="mt-1 text-sm text-muted">Ask about {summary.month} spending and budget progress.</p>
        </div>
      </div>

      {lines.length ? (
        <ol className="mt-4 grid max-h-64 gap-3 overflow-y-auto" aria-label="Chat history" aria-live="polite">
          {lines.map((line, index) => (
            <li key={`${index}-${line.role}`} className={`rounded-lg p-3 text-sm ${line.role === "you" ? "ml-6 bg-track" : "mr-3 border border-line bg-page"}`}>
              <p className="mb-1 text-xs font-medium text-muted">{line.role === "you" ? "You" : "Tally"}</p>
              <p className="whitespace-pre-wrap break-words">{line.text}</p>
            </li>
          ))}
        </ol>
      ) : null}

      <div className="mt-4 rounded-lg border border-line bg-page p-3 text-sm">
        <p className="font-medium">Before you send</p>
        <p className="mt-1 text-muted">Your question and this month’s totals, savings goal, and up to 16 category totals and limits will be sent to the configured AI provider. Transaction descriptions, dates, and individual entries stay on this device.</p>
        {availability.state !== "ready" ? <p className="mt-2 text-muted">{availability.message}</p> : null}
        <label className="mt-3 flex items-start gap-2 text-sm">
          <input type="checkbox" checked={consent} disabled={availability.state !== "ready" || pending} onChange={(event) => setConsent(event.target.checked)} className="mt-1" />
          <span>I agree to send the summary and my question to the configured provider for this chat.</span>
        </label>
      </div>

      <form className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end" onSubmit={(event) => void send(event)}>
        <label className="sr-only" htmlFor="spending-chat-input">Message</label>
        <textarea
          id="spending-chat-input"
          className="field min-h-16 flex-1 resize-y disabled:cursor-not-allowed disabled:opacity-70"
          rows={2}
          maxLength={500}
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          disabled={availability.state !== "ready" || pending}
          placeholder={availability.state === "ready" ? "Ask about this month’s budget…" : "Chat is disabled until a provider is configured"}
        />
        {pending ? (
          <button type="button" className="btn btn-quiet sm:shrink-0" onClick={() => controller.current?.abort()}>
            <Square className="size-4" aria-hidden="true" /> Cancel
          </button>
        ) : (
          <button type="submit" className="btn btn-primary sm:shrink-0" disabled={availability.state !== "ready" || !consent || !question.trim()}>
            <Send className="size-4" aria-hidden="true" /> Send
          </button>
        )}
        {pending ? <span className="sr-only" role="status"><LoaderCircle className="size-4 animate-spin" /> Thinking</span> : null}
      </form>
      {error ? <p role="alert" className="mt-2 text-sm text-expense">{error}</p> : null}
      <p className="mt-2 text-xs text-faint">Provider secrets stay on the server. The provider may process the data under its own terms. Answers are informational and may be wrong.</p>
    </section>
  );
}
