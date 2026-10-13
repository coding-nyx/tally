import { createFileRoute } from "@tanstack/react-router";
import { handleAgentRequest } from "@/lib/agent-tools/http.server";
export const Route = createFileRoute("/api/agent/$")({
  server: {
    handlers: {
      GET: ({ request }) => handleAgentRequest(request),
      POST: ({ request }) => handleAgentRequest(request),
    },
  },
});
