import { useEffect, useState } from "react";
import { Bar, BarChart, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { formatMoney, type Currency, type SpendRow } from "@/lib/budget";

function useReducedMotion(): boolean {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => setReduce(query.matches);
    apply();
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, []);
  return reduce;
}

function ChartTip({
  active,
  payload,
  currency,
}: {
  active?: boolean;
  payload?: Array<{ payload?: SpendRow }>;
  currency: Currency;
}) {
  const row = payload?.[0]?.payload;
  if (!active || !row) return null;
  return (
    <div className="rounded-sm border border-line bg-surface px-3 py-2 shadow-panel">
      <p className="text-sm font-medium">{row.category}</p>
      <p className="text-sm text-muted tabular-nums">
        {formatMoney(row.cents, currency)} · {row.share}%
      </p>
    </div>
  );
}

export function SpendChart({ rows, currency }: { rows: SpendRow[]; currency: Currency }) {
  const reduce = useReducedMotion();
  const max = rows[0]?.cents ?? 1;
  const height = Math.max(160, rows.length * 32);

  return (
    <div className="w-full min-w-0" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={rows}
          layout="vertical"
          margin={{ top: 0, right: 8, left: 0, bottom: 0 }}
          barCategoryGap={8}
        >
          <XAxis type="number" hide domain={[0, "dataMax"]} />
          <YAxis
            type="category"
            dataKey="category"
            width={104}
            axisLine={false}
            tickLine={false}
            tick={{ fill: "var(--color-muted)", fontSize: 12 }}
          />
          <Tooltip
            cursor={{ fill: "var(--color-track)" }}
            content={<ChartTip currency={currency} />}
            wrapperStyle={{ outline: "none" }}
          />
          <Bar dataKey="cents" barSize={12} radius={[0, 6, 6, 0]} isAnimationActive={!reduce}>
            {rows.map((row) => (
              <Cell
                key={row.category}
                fill="var(--color-bar)"
                fillOpacity={0.35 + 0.65 * (row.cents / max)}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
