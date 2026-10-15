/**
 * Route preloading helper for instant page transitions.
 * Invoked on hover/focus of navigation links so chunks are already cached when clicked.
 */
const routeLoaders: Record<string, () => Promise<unknown>> = {
  "/": () => import("@/features/dashboard/DashboardPage"),
  "/acquisitions": () => import("@/features/acquisitions/AcquisitionsPage"),
  "/acquisitions/new": () => import("@/features/acquisitions/AcquisitionFormPage"),
  "/intake": () => import("@/features/intake/ShorthandIntakePage"),
  "/vehicles": () => import("@/features/vehicles/InventoryPage"),
  "/vehicles/new": () => import("@/features/vehicles/VehicleFormPage"),
  "/sell": () => import("@/features/sales/SellVehiclePage"),
  "/customers": () => import("@/features/customers/CustomersPage"),
  "/expenses": () => import("@/features/expenses/ExpensePages"),
  "/users": () => import("@/features/users/UsersPage"),
  "/audit": () => import("@/features/audit/AuditPage"),
  "/approvals": () => import("@/features/approvals/ApprovalsPage"),
  "/duplicate-reviews": () =>
    import("@/features/approvals/DuplicateReviewsPage"),
  "/settings": () => import("@/features/settings/SettingsPage"),
  "/capture": () => import("@/features/capture/CapturePage"),
  "/assist": () => import("@/features/assistant/AssistPage"),
  "/assistant": () => import("@/features/assistant/CaremAssistantPage"),
  "/copilot": () => import("@/features/copilot/CopilotPage"),
  "/docs": () => import("@/features/docs/DocsPage"),
};

const preloadedRoutes = new Set<string>();

export function preloadRoute(path: string): void {
  const cleanPath = path.split("?")[0].split("#")[0];
  let loader = routeLoaders[cleanPath];

  // Dynamic route resolution for detail pages
  if (!loader) {
    if (cleanPath.startsWith("/vehicles/") && cleanPath !== "/vehicles/new") {
      loader = () => import("@/features/vehicles/VehicleDetailPage");
    } else if (cleanPath.startsWith("/sales/")) {
      loader = () => import("@/features/sales/SaleDetailPage");
    }
  }

  if (loader && !preloadedRoutes.has(cleanPath)) {
    preloadedRoutes.add(cleanPath);
    loader().catch(() => {
      preloadedRoutes.delete(cleanPath);
    });
  }
}
