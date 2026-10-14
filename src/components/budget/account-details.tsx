import { useState } from "react";
type Row = Record<string, any>;

export function AccountDetails({
  account,
  revision,
  locked,
  prepare,
  onClose,
}: {
  account: Row;
  revision: number;
  locked: boolean;
  prepare: (tool: string, args: Row) => void;
  onClose: () => void;
}) {
  const [startingRevision] = useState(revision);
  const [name, setName] = useState(account.name);
  const [institution, setInstitution] = useState(account.institution ?? "");
  const [lastFour, setLastFour] = useState(account.lastFour ?? "");
  const stale = startingRevision !== revision;
  return (
    <form
      className="mt-3 space-y-3 rounded border border-line p-3"
      aria-label={`Edit ${account.name}`}
      onSubmit={(e) => {
        e.preventDefault();
        prepare("tally_prepare_account_update", {
          accountId: account.id,
          expectedRevision: startingRevision,
          name,
          institution,
          ...(lastFour ? { lastFour } : {}),
        });
        onClose();
      }}
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <label>
          Display name
          <input
            className="field"
            maxLength={80}
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label>
          Bank / institution
          <input
            className="field"
            maxLength={80}
            value={institution}
            onChange={(e) => setInstitution(e.target.value)}
          />
        </label>
        <label>
          Last four digits
          <input
            className="field"
            maxLength={4}
            pattern="[0-9]{4}"
            inputMode="numeric"
            value={lastFour}
            onChange={(e) => setLastFour(e.target.value)}
          />
        </label>
      </div>
      <p className="text-xs text-muted">
        Only the last four digits are recorded. Leave them unchanged to retain an existing
        identifier.
      </p>
      {stale && (
        <p role="alert" className="text-expense">
          The ledger changed. Close and reopen these details before preparing a change.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button className="btn btn-primary" disabled={locked || stale}>
          Preview account details
        </button>
        <button className="btn btn-quiet" type="button" onClick={onClose}>
          Close details
        </button>
      </div>
    </form>
  );
}
