import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { validateSpendingChatRequest } from "./spending-chat";

const spendingChatRequestSchema = z.object({
  question: z.string().trim().min(1).max(500),
  summary: z.object({
    currency: z.enum(["INR", "USD"]),
    month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
    incomeCents: z.number().int().nonnegative().max(100_000_000_000),
    spendingCents: z.number().int().nonnegative().max(100_000_000_000),
    remainingCents: z.number().int().max(100_000_000_000).min(-100_000_000_000),
    goal: z.object({ name: z.string().max(40), targetCents: z.number().int().nonnegative().max(100_000_000_000) }),
    categories: z.array(z.object({
      name: z.string().max(40),
      spentCents: z.number().int().nonnegative().max(100_000_000_000),
      budgetCents: z.number().int().nonnegative().max(100_000_000_000).nullable(),
    })).max(16),
  }),
});

export const getSpendingChatStatus = createServerFn({ method: "GET" }).handler(async () => {
  const { spendingChatServerAvailability } = await import("./spending-chat.server");
  return { configured: spendingChatServerAvailability() };
});

export const askSpendingQuestion = createServerFn({ method: "POST" })
  .validator(spendingChatRequestSchema)
  .handler(async ({ data }) => {
    const parsed = validateSpendingChatRequest(data);
    if (!parsed) throw new Error("The question or spending summary is invalid. Review it and try again.");
    const { answerSpendingQuestion } = await import("./spending-chat.server");
    return { answer: await answerSpendingQuestion(parsed, getRequest().signal) };
  });
