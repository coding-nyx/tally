import { createFileRoute } from "@tanstack/react-router";
import { AgentWorkspace } from "@/components/budget/agent-workspace";
export const Route = createFileRoute("/agents")({ component: AgentWorkspace });
