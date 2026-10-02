import type { Profile } from "@/types";
export const canOperate = (p: Profile | null) =>
  !!p?.active && ["OWNER", "MANAGER", "STAFF"].includes(p.role);
export const canFinance = (p: Profile | null) =>
  !!p?.active &&
  (p.role === "OWNER" || (p.role === "MANAGER" && p.can_view_financials));
export const canManage = (p: Profile | null) =>
  !!p?.active && ["OWNER", "MANAGER"].includes(p.role);
export const isOwner = (p: Profile | null) => !!p?.active && p.role === "OWNER";
// More granular permissions for better access control
export const canCreateVehicle = (p: Profile | null) =>
  !!p?.active && ["OWNER", "MANAGER", "STAFF"].includes(p.role);
export const canEditVehicle = (p: Profile | null) =>
  !!p?.active && ["OWNER", "MANAGER", "STAFF"].includes(p.role);
export const canDeleteVehicle = (p: Profile | null) =>
  !!p?.active && ["OWNER", "MANAGER"].includes(p.role);
export const canCreateSale = (p: Profile | null) =>
  !!p?.active && ["OWNER", "MANAGER", "STAFF"].includes(p.role);
export const roleLabels = {
  OWNER: "Chủ cửa hàng",
  MANAGER: "Quản lý",
  STAFF: "Nhân viên",
};
