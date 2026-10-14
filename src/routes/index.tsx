import { createFileRoute } from "@tanstack/react-router";
import { dashboardSearch } from "@/lib/agent-tools/dashboard";
import { BudgetApp } from "@/components/budget/budget-app";

export const Route = createFileRoute("/")({
  validateSearch: dashboardSearch,
  component: DashboardPage,
});

function DashboardPage() {
  return <BudgetApp {...Route.useSearch()} />;
}
