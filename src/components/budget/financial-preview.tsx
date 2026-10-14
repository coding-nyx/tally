import { ReviewDetails } from "./review-details";
import { useState } from "react";
import type { TallyClient } from "@/lib/agent-tools/client";
import type { Currency } from "@/lib/budget";
type Row = Record<string, any>;
export function FinancialPreview({
  preview,
  client,
  currency,
  revision,
  busy,
  run,
  onDone,
}: {
  preview: Row;
  client: TallyClient;
  currency: Currency;
  revision: number;
  busy: boolean;
  run: (tool: string, args: Row, onResult?: (value: Row) => void) => Promise<void>;
  onDone: () => void;
}) {
  const [approvalId, setApprovalId] = useState("");
  const [approved, setApproved] = useState(false);
  const [error, setError] = useState("");
  const [reviewing, setReviewing] = useState(false);
  const stale = revision !== preview.revision;
  return (
    <section className="panel space-y-3" aria-label="Financial preview">
      <h2 className="text-lg font-medium">Review proposed change</h2>
      <p>Nothing is saved until you commit this frozen preview.</p>
      <ReviewDetails value={preview.review} currency={currency} />
      {stale && <p role="alert">The ledger changed. Cancel and prepare a fresh preview.</p>}
      {error && <p role="alert">{error}</p>}
      <div className="flex flex-wrap gap-2">
        {preview.approvalRequired !== false && !approvalId && (
          <button
            className="btn"
            disabled={busy || reviewing || stale}
            onClick={() =>
              void run("tally_request_approval", { currency, planId: preview.planId }, (v) =>
                setApprovalId(v.approvalId),
              )
            }
          >
            Request review
          </button>
        )}
        {approvalId && !approved && (
          <button
            className="btn"
            disabled={busy || reviewing || stale}
            onClick={async () => {
              setReviewing(true);
              setError("");
              try {
                await client.request("/approvals", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({
                    approvalId,
                    previewHash: preview.previewHash,
                    approve: true,
                  }),
                });
                setApproved(true);
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setReviewing(false);
              }
            }}
          >
            Approve displayed preview
          </button>
        )}
        <button
          className="btn btn-primary"
          disabled={busy || reviewing || stale || (preview.approvalRequired !== false && !approved)}
          onClick={() =>
            void run(
              preview.commitTool,
              {
                currency,
                expectedRevision: preview.revision,
                planId: preview.planId,
                previewHash: preview.previewHash,
                ...(approvalId ? { approvalId } : {}),
              },
              onDone,
            )
          }
        >
          Commit displayed preview
        </button>
        <button
          className="btn"
          disabled={busy || reviewing}
          onClick={() =>
            void run("tally_cancel_operation", { currency, operationId: preview.planId }, onDone)
          }
        >
          Cancel preview
        </button>
      </div>
    </section>
  );
}
