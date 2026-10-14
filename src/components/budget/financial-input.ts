export function inputMinor(value: FormDataEntryValue | null, allowZero = true) {
  const text = String(value ?? "").trim();
  if (!/^\d{1,10}(\.\d{1,2})?$/.test(text))
    throw new Error("Enter an amount with at most two decimals.");
  const [whole, fraction = ""] = text.split(".");
  const n = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  if (n > 1_000_000_000_000n || (!allowZero && !n))
    throw new Error("Amount is outside the supported range.");
  return Number(n);
}
