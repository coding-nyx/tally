import { useRef, useState } from "react";
import { inputMinor } from "./financial-input";
type Row = Record<string, any>;
export function CardDetails({
  accounts,
  revision,
  locked,
  prepare,
}: {
  accounts: Row[];
  revision: number;
  locked: boolean;
  prepare: (tool: string, args: Row) => void;
}) {
  const [error, setError] = useState("");
  const original = useRef<number | null>(null);
  return (
    <section className="panel space-y-3">
      <h2 className="text-lg font-medium">Credit card limits and bills</h2>
      <p className="text-sm text-muted">
        Recorded outstanding debt comes from journals. Statement due is a separate dated bill,
        reduced only by recorded card settlements after statement day. Pending transactions and
        unrecorded repayments are excluded.
      </p>
      {error && <p role="alert">{error}</p>}
      <form
        className="grid gap-3 sm:grid-cols-2"
        onChange={() => {
          original.current ??= revision;
        }}
        onReset={() => {
          original.current = null;
          setError("");
        }}
        onSubmit={(e) => {
          e.preventDefault();
          try {
            const f = new FormData(e.currentTarget);
            const mode = String(f.get("mode"));
            prepare("tally_prepare_account_update", {
              accountId: String(f.get("card")),
              expectedRevision: original.current ?? revision,
              ...(mode === "limit"
                ? { cardTerms: { creditLimitMinor: inputMinor(f.get("limit"), false) } }
                : {
                    cardBill: {
                      statementDate: String(f.get("statement")),
                      dueDate: String(f.get("due")),
                      totalDueMinor: inputMinor(f.get("total")),
                      minimumDueMinor: inputMinor(f.get("minimum")),
                    },
                  }),
            });
          } catch (e) {
            setError((e as Error).message);
          }
        }}
      >
        <label>
          Card
          <select className="field w-full" aria-label="Card" name="card" required disabled={locked}>
            <option value="">Choose card</option>
            {accounts
              .filter((a) => a.type === "credit_card" && !a.archived)
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
          </select>
        </label>
        <label>
          Record
          <select className="field w-full" aria-label="Record" name="mode" disabled={locked}>
            <option value="bill">Dated statement bill</option>
            <option value="limit">Credit limit only</option>
          </select>
        </label>
        <label>
          Credit limit
          <input className="field w-full" inputMode="decimal" name="limit" disabled={locked} />
        </label>
        <p className="text-sm text-muted">
          For “Credit limit only”, fill only the limit. For a bill, fill its four fields below.
        </p>
        <label>
          Statement date (end of day)
          <input className="field w-full" name="statement" type="date" disabled={locked} />
        </label>
        <label>
          Payment due date
          <input className="field w-full" name="due" type="date" disabled={locked} />
        </label>
        <label>
          Total statement due
          <input className="field w-full" inputMode="decimal" name="total" disabled={locked} />
        </label>
        <label>
          Minimum due
          <input className="field w-full" inputMode="decimal" name="minimum" disabled={locked} />
        </label>
        <button className="btn btn-primary" disabled={locked}>
          Preview card details
        </button>
        <button className="btn btn-quiet" type="reset" disabled={locked}>
          Reset card draft
        </button>
      </form>
      <p className="text-xs text-muted">
        Corrections append bill observations and preserve earlier entries. No payments, bank
        connections, interest or fees are created automatically.
      </p>
    </section>
  );
}
