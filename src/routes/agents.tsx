import { createFileRoute } from "@tanstack/react-router";
import { AgentWorkspace } from "@/components/budget/agent-workspace";
import { dashboardSearch } from "@/lib/agent-tools/dashboard";
export const Route = createFileRoute("/agents")({
  validateSearch: dashboardSearch,
  component: WorkspacePage,
});

function WorkspacePage() {
  return <AgentWorkspace initial={Route.useSearch()} />;
}
