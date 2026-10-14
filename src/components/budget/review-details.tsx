import { formatMoney, type Currency } from "@/lib/budget";

const label = (key: string) =>
  key
    .replace(/(?:Minor|Cents)$/, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replaceAll("_", " ");

/** Readable projection only: the frozen service payload remains available in full. */
export function ReviewDetails({ value, currency }: { value: unknown; currency: Currency }) {
  function render(item: unknown, key = "", depth = 0): React.ReactNode {
    if (item === null || item === undefined) return <span className="text-muted">Unknown</span>;
    if (typeof item === "boolean") return item ? "Yes" : "No";
    if (typeof item === "number")
      return /(?:Minor|Cents)$/.test(key) ? formatMoney(item, currency) : String(item);
    if (typeof item !== "object") return String(item);
    if (depth > 3) return <span className="text-muted">See full details below</span>;
    if (Array.isArray(item))
      return item.length ? (
        <div className="space-y-2">
          {item.slice(0, 20).map((row, i) => (
            <div className="rounded border border-line p-2" key={i}>
              {render(row, key, depth + 1)}
            </div>
          ))}
          {item.length > 20 && (
            <p className="text-muted">
              Showing 20 of {item.length}. Review the full details below for all items.
            </p>
          )}
        </div>
      ) : (
        <span className="text-muted">None</span>
      );
    return (
      <dl className="review-details space-y-2">
        {Object.entries(item).map(([name, child]) => (
          <div
            key={name}
            className="grid gap-1 border-b border-line pb-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]"
          >
            <dt className="capitalize text-muted">{label(name)}</dt>
            <dd className="min-w-0">{render(child, name, depth + 1)}</dd>
          </div>
        ))}
      </dl>
    );
  }
  return (
    <div className="space-y-3 text-sm">
      {render(value)}
      <details>
        <summary className="cursor-pointer py-2 font-medium">Full frozen details</summary>
        <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words text-xs">
          {JSON.stringify(value, null, 2)}
        </pre>
      </details>
    </div>
  );
}
