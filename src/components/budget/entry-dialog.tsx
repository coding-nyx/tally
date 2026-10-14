import { useState, type FormEvent } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  categoriesFor,
  centsToInput,
  parseMoneyToCents,
  type Currency,
  type Transaction,
  type TxKind,
} from "@/lib/budget";

type Draft = {
  kind: TxKind;
  amountCents: number;
  category: string;
  note: string;
  date: string;
};

type EntryDialogProps = {
  mode: "create" | "edit";
  initial: Pick<Transaction, "kind" | "amountCents" | "category" | "note" | "date"> | null;
  defaultDate: string;
  currency: Currency;
  categories?: { kind: TxKind; name: string; archived: boolean }[];
  busy?: boolean;
  failure?: string;
  pending?: boolean;
  onRetry?: () => void;
  onClose: () => void;
  onSave: (draft: Draft) => void;
};

export function EntryDialog({
  mode,
  initial,
  defaultDate,
  currency,
  categories,
  busy = false,
  failure = "",
  pending = false,
  onRetry,
  onClose,
  onSave,
}: EntryDialogProps) {
  const optionsFor = (kind: TxKind): readonly string[] =>
    categories
      ? categories.filter((c) => c.kind === kind && !c.archived).map((c) => c.name)
      : categoriesFor(kind);
  const [kind, setKind] = useState<TxKind>(initial?.kind ?? "expense");
  const [amount, setAmount] = useState(initial ? centsToInput(initial.amountCents) : "");
  const [category, setCategory] = useState(
    initial?.category ?? optionsFor(initial?.kind ?? "expense")[0] ?? "",
  );
  const [note, setNote] = useState(initial?.note ?? "");
  const [date, setDate] = useState(initial?.date ?? defaultDate);
  const [error, setError] = useState("");

  const options = optionsFor(kind);
  const selectedCategory = options.includes(category) ? category : options[0];

  function chooseKind(next: TxKind) {
    setKind(next);
    const nextOptions = optionsFor(next);
    if (!nextOptions.includes(category)) setCategory(nextOptions[0] ?? "");
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (!selectedCategory) {
      setError("Create an active category before adding this entry.");
      return;
    }
    const amountCents = parseMoneyToCents(amount);
    if (amountCents === null) {
      setError("Enter an amount greater than zero, like 42.50.");
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      setError("Choose a date.");
      return;
    }
    onSave({
      kind,
      amountCents,
      category: selectedCategory ?? "",
      note: note.trim(),
      date,
    });
  }

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="overlay" />
        <div className="fixed inset-0 z-50 flex items-end justify-center p-4 sm:items-center">
          <Dialog.Content className="dialog" aria-describedby="entry-desc">
            <Dialog.Title className="font-display text-2xl tracking-tight">
              {mode === "create" ? "Add entry" : "Edit entry"}
            </Dialog.Title>
            <Dialog.Description id="entry-desc" className="mt-1 text-sm text-muted">
              Income raises the balance. An expense lowers it right away.
            </Dialog.Description>
            {pending && (
              <div className="mt-3" role="alert">
                <p className="text-expense">{failure}</p>
                <button className="btn btn-primary mt-2" disabled={busy} onClick={onRetry}>
                  Retry same request
                </button>
              </div>
            )}
            <form className="mt-5 flex flex-col gap-4" onSubmit={submit}>
              <fieldset className="contents" disabled={busy || pending}>
                <div className="seg grid-cols-2" role="group" aria-label="Entry type">
                  {(["income", "expense"] as const).map((option) => (
                    <button
                      key={option}
                      type="button"
                      aria-pressed={kind === option}
                      onClick={() => chooseKind(option)}
                    >
                      {option === "income" ? "Income" : "Expense"}
                    </button>
                  ))}
                </div>
                <div>
                  <label className="mb-2 block text-sm font-medium" htmlFor="amount">
                    Amount
                  </label>
                  <div className="relative">
                    <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted">
                      {currency === "INR" ? "₹" : "$"}
                    </span>
                    <input
                      id="amount"
                      className="field pl-7 tabular-nums"
                      inputMode="decimal"
                      autoComplete="off"
                      autoFocus
                      placeholder="0.00"
                      value={amount}
                      onChange={(event) => {
                        setAmount(event.target.value);
                        setError("");
                      }}
                    />
                  </div>
                </div>
                <div>
                  <label className="mb-2 block text-sm font-medium" htmlFor="category">
                    Category
                  </label>
                  <select
                    id="category"
                    className="field select"
                    value={selectedCategory}
                    onChange={(event) => setCategory(event.target.value)}
                  >
                    {options.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="mb-2 block text-sm font-medium" htmlFor="entry-date">
                    Date
                  </label>
                  <input
                    id="entry-date"
                    className="field"
                    type="date"
                    value={date}
                    onChange={(event) => setDate(event.target.value)}
                    required
                  />
                </div>
                <div>
                  <label className="mb-2 block text-sm font-medium" htmlFor="note">
                    Note <span className="font-normal text-muted">optional</span>
                  </label>
                  <input
                    id="note"
                    className="field"
                    maxLength={80}
                    autoComplete="off"
                    placeholder="What was this for?"
                    value={note}
                    onChange={(event) => setNote(event.target.value)}
                  />
                </div>
                {error || failure ? (
                  <p className="text-sm text-expense" role="alert">
                    {error || failure}
                  </p>
                ) : null}
                <div className="grid grid-cols-2 gap-2 sm:flex sm:justify-end">
                  <Dialog.Close type="button" className="btn btn-quiet">
                    Cancel
                  </Dialog.Close>
                  <button type="submit" className="btn btn-primary">
                    {mode === "create" ? "Add entry" : "Save changes"}
                  </button>
                </div>
              </fieldset>
            </form>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
