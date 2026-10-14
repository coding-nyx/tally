import { useEffect, useRef, useState } from "react";
import { monthKey, type BudgetData, type Currency } from "@/lib/budget";
import { TallyClient, TallyClientError, agentBaseUrl } from "@/lib/agent-tools/client";
import { readDashboard, type DashboardCategory } from "@/lib/agent-tools/dashboard";
type Pending = {
  tool: string;
  args: Record<string, unknown>;
  key: string;
  done?: (result: Record<string, any>) => void;
};
export function useSharedBudget(initial: { currency?: Currency; month?: string } = {}) {
  const [client, setClient] = useState<TallyClient | null>(null);
  const [currency, setCurrency] = useState<Currency>(initial.currency ?? "INR");
  const [month, setMonth] = useState(initial.month ?? monthKey(new Date()));
  const [data, setData] = useState<BudgetData | null>(null);
  const [revision, setRevision] = useState(0);
  const [categories, setCategories] = useState<DashboardCategory[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [needsCredential, setNeedsCredential] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const writeLock = useRef(false);
  const pendingRef = useRef<Pending | null>(null);
  const epoch = useRef(0);
  const connecting = useRef<AbortController | null>(null);
  const reading = useRef<AbortController | null>(null);
  async function connect(token = "") {
    connecting.current?.abort();
    const controller = new AbortController();
    connecting.current = controller;
    setLoading(true);
    setError("");
    try {
      const active = new TallyClient(agentBaseUrl(window.location), token);
      await active.discover(AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]));
      if (!controller.signal.aborted) {
        setNeedsCredential(false);
        setClient(active);
      }
    } catch (e) {
      if (!controller.signal.aborted) {
        setNeedsCredential(e instanceof TallyClientError && e.code === "unauthorized");
        setError((e as Error).message);
        setLoading(false);
      }
    }
  }
  async function refresh(
    active = client,
    selectedCurrency = currency,
    selectedMonth = month,
    clear = false,
  ) {
    if (!active) return;
    reading.current?.abort();
    const controller = new AbortController();
    reading.current = controller;
    const generation = ++epoch.current;
    if (clear) setData(null);
    setLoading(true);
    try {
      const snapshot = await readDashboard(
        active,
        selectedCurrency,
        selectedMonth,
        AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]),
      );
      if (generation !== epoch.current || controller.signal.aborted) return;
      setData(snapshot.data);
      setRevision(snapshot.revision);
      setCategories(snapshot.categories);
      if (!pendingRef.current) setError("");
    } catch (e) {
      if (generation === epoch.current && !controller.signal.aborted)
        setError((e as Error).message);
    } finally {
      if (generation === epoch.current) setLoading(false);
    }
  }
  useEffect(() => {
    if (initial.currency) setCurrency(initial.currency);
    if (initial.month) setMonth(initial.month);
  }, [initial.currency, initial.month]);
  useEffect(() => {
    void connect();
    return () => {
      connecting.current?.abort();
      reading.current?.abort();
      epoch.current += 1;
    };
  }, []);
  useEffect(() => {
    void refresh(client, currency, month, true);
    return () => {
      reading.current?.abort();
      epoch.current += 1;
    };
    // Scope changes must invalidate the displayed read model.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, currency, month]);
  useEffect(() => {
    const update = () => {
      if (document.visibilityState === "visible" && !writeLock.current && !pendingRef.current)
        void refresh();
    };
    window.addEventListener("focus", update);
    document.addEventListener("visibilitychange", update);
    const timer = window.setInterval(update, 30000);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", update);
      document.removeEventListener("visibilitychange", update);
    };
    // The current view is refreshed when returning to it and while it remains open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, currency, month]);
  async function execute(request: Pending) {
    if (!client || writeLock.current) return;
    writeLock.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await client.call(
        request.tool,
        request.args,
        request.key,
        AbortSignal.timeout(20000),
      );
      pendingRef.current = null;
      setPending(null);
      request.done?.(result);
      await refresh();
      return result;
    } catch (e) {
      const uncertain = !(e instanceof TallyClientError) || e.code === "unavailable";
      if (uncertain) {
        pendingRef.current = request;
        setPending(request);
      } else {
        pendingRef.current = null;
        setPending(null);
      }
      setError(
        uncertain
          ? "The response was interrupted. Retry the same request to retrieve its receipt before making another change."
          : (e as Error).message,
      );
      if (e instanceof TallyClientError && ["revision_conflict", "stale_cursor"].includes(e.code)) {
        await refresh();
        setError(e.message);
      }
      return undefined;
    } finally {
      writeLock.current = false;
      setBusy(false);
    }
  }
  async function mutate(
    tool: string,
    args: Record<string, unknown>,
    done?: (result: Record<string, any>) => void,
  ) {
    if (pendingRef.current || writeLock.current) return;
    return execute({ tool, args, key: crypto.randomUUID(), done });
  }
  return {
    client,
    data,
    currency,
    setCurrency,
    month,
    setMonth,
    revision,
    categories,
    error,
    busy,
    loading,
    needsCredential,
    pending,
    connect,
    refresh,
    mutate,
    retry: () => (pendingRef.current ? execute(pendingRef.current) : undefined),
  };
}
