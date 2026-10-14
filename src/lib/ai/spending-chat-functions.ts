import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

/** Browser-local aggregates are not an authorization or provider-consent proof.
 * Provider calls now exclusively use the canonical agent-tools context/approval service.
 */
export const getSpendingChatStatus = createServerFn({ method: "GET" }).handler(
  async (): Promise<{ configured: boolean }> => ({ configured: false }),
);
export const askSpendingQuestion = createServerFn({ method: "POST" })
  .validator(z.object({ question: z.string().max(500), summary: z.unknown() }))
  .handler(async (): Promise<{ answer: string }> => {
    throw new Error(
      "Use the shared workspace to approve and send a spending question. Browser-local provider calls are disabled.",
    );
  });
