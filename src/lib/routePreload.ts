/**
 * Route preloading helper for instant page transitions.
 * Invoked on hover/focus of navigation links so chunks are already cached when clicked.
 */
const routeLoaders: Record<string, () => Promise<unknown>> = {
  "/": () => import("@/features/dashboard/DashboardPage"),
  "/acquisitions": () => import("@/features/acquisitions/AcquisitionPages"),
  "/acquisitions/new": () => import("@/features/acquisitions/AcquisitionPages"),
  "/vehicles": () => import("@/features/vehicles/VehiclePages"),
  "/vehicles/new": () => import("@/features/vehicles/VehiclePages"),
  "/sales": () => import("@/features/sales/SalePages"),
  "/sell": () => import("@/features/sales/SalePages"),
  "/receivables": () => import("@/features/sales/ReceivablesPage"),
  "/customers": () => import("@/features/customers/CustomersPage"),
  "/reports": () => import("@/features/reports/ReportsPage"),
  "/expenses": () => import("@/features/expenses/ExpensePages"),
  "/users": () => import("@/features/users/UsersPage"),
  "/audit": () => import("@/features/audit/AuditPage"),
  "/settings": () => import("@/features/settings/SettingsPage"),
  "/capture": () => import("@/features/capture/CapturePage"),
  "/assist": () => import("@/features/assistant/AssistPage"),
  "/copilot": () => import("@/features/copilot/CopilotPage"),
  "/docs": () => import("@/features/docs/DocsPage"),
};

const preloadedRoutes = new Set<string>();

export function preloadRoute(path: string): void {
  const cleanPath = path.split("?")[0].split("#")[0];
  const loader = routeLoaders[cleanPath];
  if (loader && !preloadedRoutes.has(cleanPath)) {
    preloadedRoutes.add(cleanPath);
    loader().catch(() => {
      preloadedRoutes.delete(cleanPath);
    });
  }
}
