import { Component, lazy, Suspense, type ReactNode } from "react";
import { Navigate, Outlet, Route, Routes, useLocation } from "react-router-dom";
import { useAuth } from "@/features/auth/AuthProvider";
import { canManage, canOperate, isOwner } from "@/lib/permissions";
import { Button, EmptyState, ErrorState, Loading } from "@/components/ui";
import AppLayout from "@/layouts/AppLayout";
import LoginPage, { PasswordPage } from "@/features/auth/LoginPage";
import ChangePasswordPage from "@/features/auth/ChangePasswordPage";
import { PwaUpdate } from "@/components/PwaUpdate";
const DashboardPage = lazy(() => import("@/features/dashboard/DashboardPage"));
const AcquisitionsPage = lazy(() =>
  import("@/features/acquisitions/AcquisitionPages").then((m) => ({
    default: m.AcquisitionsPage,
  })),
);
const AcquisitionFormPage = lazy(() =>
  import("@/features/acquisitions/AcquisitionPages").then((m) => ({
    default: m.AcquisitionFormPage,
  })),
);
const InventoryPage = lazy(() =>
  import("@/features/vehicles/VehiclePages").then((m) => ({
    default: m.InventoryPage,
  })),
);
const VehicleFormPage = lazy(() =>
  import("@/features/vehicles/VehiclePages").then((m) => ({
    default: m.VehicleFormPage,
  })),
);
const VehicleDetailPage = lazy(() =>
  import("@/features/vehicles/VehiclePages").then((m) => ({
    default: m.VehicleDetailPage,
  })),
);
const SalesPage = lazy(() =>
  import("@/features/sales/SalePages").then((m) => ({ default: m.SalesPage })),
);
const SaleDetailPage = lazy(() =>
  import("@/features/sales/SalePages").then((m) => ({
    default: m.SaleDetailPage,
  })),
);
const SellVehiclePage = lazy(() =>
  import("@/features/sales/SalePages").then((m) => ({
    default: m.SellVehiclePage,
  })),
);
const ExpensesPage = lazy(() =>
  import("@/features/expenses/ExpensePages").then((m) => ({
    default: m.ExpensesPage,
  })),
);
const ReportsPage = lazy(() => import("@/features/reports/ReportsPage"));
const UsersPage = lazy(() => import("@/features/users/UsersPage"));
const AuditPage = lazy(() => import("@/features/audit/AuditPage"));
const SettingsPage = lazy(() => import("@/features/settings/SettingsPage"));
const ReceivablesPage = lazy(() =>
  import("@/features/sales/ReceivablesPage").then((m) => ({
    default: m.ReceivablesPage,
  })),
);
const CustomersPage = lazy(() =>
  import("@/features/customers/CustomersPage").then((m) => ({
    default: m.CustomersPage,
  })),
);
const ReconciliationPage = lazy(() =>
  import("@/features/reports/ReconciliationPage").then((m) => ({
    default: m.ReconciliationPage,
  })),
);
const ImportVehiclesPage = lazy(() =>
  import("@/features/vehicles/ImportVehiclesPage").then((m) => ({
    default: m.ImportVehiclesPage,
  })),
);
const CapturePage = lazy(() => import("@/features/capture/CapturePage"));
const AssistPage = lazy(() => import("@/features/assistant/AssistPage"));
function Protected({
  access = "read",
}: {
  access?: "read" | "operate" | "manage" | "owner";
}) {
  const { loading, profile, user, error, signOut } = useAuth();
  const location = useLocation();
  if (loading) return <Loading />;
  if (!user)
    return (
      <Navigate
        to="/login"
        replace
        state={{ from: location.pathname + location.search }}
      />
    );
  if (!profile)
    return (
      <div className="auth-simple">
        <ErrorState error={error} />
        <Button onClick={() => void signOut()}>Về đăng nhập</Button>
      </div>
    );

  // Redirect to change password if required (unless already on that page)
  if (
    profile.must_change_password &&
    location.pathname !== "/change-password"
  ) {
    return (
      <Navigate
        to="/change-password"
        replace
        state={{ from: location.pathname + location.search + location.hash }}
      />
    );
  }

  if (
    (access === "operate" && !canOperate(profile)) ||
    (access === "manage" && !canManage(profile)) ||
    (access === "owner" && !isOwner(profile))
  )
    return (
      <EmptyState
        title="Bạn chưa được cấp quyền mở trang này"
        description="Liên hệ chủ cửa hàng nếu cần thay đổi quyền truy cập."
      />
    );
  return <Outlet />;
}
class ErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: Error) {
    console.error("Application error", error);
  }
  render() {
    return this.state.failed ? (
      <div className="auth-simple">
        <h1>Ứng dụng cần tải lại</h1>
        <p>Công việc đã lưu vẫn được giữ tại cửa hàng.</p>
        <Button onClick={() => location.reload()}>Tải lại trang</Button>
      </div>
    ) : (
      this.props.children
    );
  }
}
export default function App() {
  return (
    <ErrorBoundary>
      <PwaUpdate />
      <Suspense fallback={<Loading />}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          {import.meta.env.VITE_ENABLE_PASSWORD_RESET === "true" && (
            <Route path="/forgot-password" element={<PasswordPage />} />
          )}
          <Route path="/reset-password" element={<PasswordPage reset />} />
          <Route path="/change-password" element={<ChangePasswordPage />} />
          <Route element={<Protected />}>
            <Route element={<AppLayout />}>
              <Route index element={<DashboardPage />} />
              {/* Thu vào (Acquisitions) */}
              <Route path="acquisitions" element={<AcquisitionsPage />} />
              {/* Tồn kho (Inventory) */}
              <Route path="vehicles" element={<InventoryPage />} />
              <Route path="vehicles/:id" element={<VehicleDetailPage />} />
              {/* Bán ra (Sales) */}
              <Route path="sales" element={<SalesPage />} />
              <Route path="sales/:id" element={<SaleDetailPage />} />
              <Route path="capture" element={<CapturePage />} />
              <Route path="assist" element={<AssistPage />} />
              <Route path="receivables" element={<ReceivablesPage />} />
              <Route path="customers" element={<CustomersPage />} />
              <Route path="settings" element={<SettingsPage />} />
              <Route element={<Protected access="operate" />}>
                <Route
                  path="acquisitions/new"
                  element={<AcquisitionFormPage />}
                />
                <Route path="vehicles/new" element={<VehicleFormPage />} />
                <Route path="vehicles/:id/edit" element={<VehicleFormPage />} />
                <Route path="vehicles/:id/sell" element={<SellVehiclePage />} />
                <Route path="sell" element={<SellVehiclePage />} />
                <Route
                  path="import-vehicles"
                  element={<ImportVehiclesPage />}
                />
              </Route>
              <Route element={<Protected access="manage" />}>
                <Route path="reconciliation" element={<ReconciliationPage />} />
                <Route path="expenses" element={<ExpensesPage />} />
                <Route path="reports" element={<ReportsPage />} />
              </Route>
              <Route element={<Protected access="owner" />}>
                <Route path="users" element={<UsersPage />} />
                <Route path="audit" element={<AuditPage />} />
              </Route>
            </Route>
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </ErrorBoundary>
  );
}
