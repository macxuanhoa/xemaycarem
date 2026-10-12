import { useCallback, useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useAuth } from "@/features/auth/AuthProvider";
import { canFinance, canManage, canOperate, isOwner } from "@/lib/permissions";
import type { Acquisition, CustomerSummary, Paged, Vehicle } from "@/types";

const BADGE_STORAGE_KEY = "carem_nav_seen_counts_v1";

type BadgeKey =
  | "vehicles"
  | "acquisitions"
  | "customers"
  | "approvals"
  | "bankReconciliation";

type SeenState = Record<BadgeKey, number>;

function getStoredSeen(): Partial<SeenState> {
  try {
    const raw = localStorage.getItem(BADGE_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveStoredSeen(state: Partial<SeenState>) {
  try {
    localStorage.setItem(BADGE_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Ignore storage quota or access errors
  }
}

export function useNavBadges() {
  const { profile } = useAuth();
  const { pathname } = useLocation();

  // Local state initialized from localStorage
  const [seenState, setSeenState] = useState<Partial<SeenState>>(() =>
    getStoredSeen(),
  );

  const canReadOperate = canOperate(profile);
  const canReadManage = canManage(profile);
  const isOwnerUser = isOwner(profile);
  const canReadFinance = canFinance(profile);

  // 1. Tồn kho (Vehicles)
  const vehiclesQuery = useQuery({
    queryKey: ["vehicles", "nav-badge-count"],
    queryFn: () =>
      api.call<Paged<Vehicle>>("list_vehicles", {
        p_filters: { limit: 1 },
      }),
    refetchInterval: 15_000,
  });

  // 2. Thu vào / Thu xe (Acquisitions)
  const acquisitionsQuery = useQuery({
    queryKey: ["acquisitions", "nav-badge-count"],
    queryFn: () =>
      api.call<Paged<Acquisition>>("list_acquisitions", {
        p_filters: { limit: 1 },
      }),
    enabled: canReadOperate,
    refetchInterval: 15_000,
  });

  // 3. Khách hàng (Customers)
  const customersQuery = useQuery({
    queryKey: ["customers", "nav-badge-count"],
    queryFn: () =>
      api.call<Paged<CustomerSummary>>("list_customers", {
        p_filters: { limit: 1 },
      }),
    refetchInterval: 15_000,
  });

  // 4. Chờ duyệt (Approvals)
  const approvalsQuery = useQuery({
    queryKey: ["approvals", "nav-badge-count"],
    queryFn: async () => {
      let total = 0;
      if (isOwnerUser) {
        const res = await api.listPendingApprovals({
          limit: 1,
          exclude_kind: "VEHICLE_DUPLICATE_REVIEW",
        });
        total += res?.total ?? 0;
      }
      if (canReadManage) {
        const dupRes = await api.listVehicleDuplicateReviews({ limit: 1 });
        total += dupRes?.total ?? 0;
      }
      return total;
    },
    enabled: canReadManage || isOwnerUser,
    refetchInterval: 15_000,
  });

  // 5. Đối soát chuyển khoản (Bank Reconciliation)
  const reconciliationQuery = useQuery({
    queryKey: ["bank-transactions", "nav-badge-count"],
    queryFn: async () => {
      const res = await api.listBankTransactions({
        status: "UNMATCHED",
        limit: 1,
      });
      return res?.pending_count ?? res?.total ?? 0;
    },
    enabled: canReadFinance,
    refetchInterval: 15_000,
  });

  const totals: Record<BadgeKey, number | undefined> = {
    vehicles: vehiclesQuery.data?.total,
    acquisitions: acquisitionsQuery.data?.total,
    customers: customersQuery.data?.total,
    approvals: approvalsQuery.data,
    bankReconciliation: reconciliationQuery.data,
  };

  // Helper compute unread count for a category
  const computeUnread = useCallback(
    (key: BadgeKey, isQueue = false): number => {
      const total = totals[key];
      if (total === undefined || total === null) return 0;
      const seen = seenState[key];

      if (seen === undefined) {
        // First visit initialization:
        // For action queues (approvals, bank reconciliation), existing pending items are shown as unread.
        // For accumulating data (vehicles, acquisitions, customers), initialize seen to current total.
        if (isQueue) {
          return total;
        } else {
          // Initialize seen so historical data isn't counted as new
          const next = { ...getStoredSeen(), [key]: total };
          saveStoredSeen(next);
          setSeenState(next);
          return 0;
        }
      }

      if (total < seen) {
        // Items were removed/processed
        const next = { ...getStoredSeen(), [key]: total };
        saveStoredSeen(next);
        setSeenState(next);
        return 0;
      }

      return Math.max(0, total - seen);
    },
    [totals, seenState],
  );

  const markSeen = useCallback(
    (key: BadgeKey) => {
      const total = totals[key] ?? 0;
      setSeenState((prev) => {
        if (prev[key] === total) return prev;
        const next = { ...prev, [key]: total };
        saveStoredSeen(next);
        return next;
      });
    },
    [totals],
  );

  // Auto-clear badge when user is visiting the matching route
  useEffect(() => {
    if (pathname.startsWith("/vehicles")) {
      markSeen("vehicles");
    } else if (
      pathname.startsWith("/acquisitions") ||
      pathname.startsWith("/intake")
    ) {
      markSeen("acquisitions");
    } else if (pathname.startsWith("/customers")) {
      markSeen("customers");
    } else if (
      pathname.startsWith("/approvals") ||
      pathname.startsWith("/duplicate-reviews")
    ) {
      markSeen("approvals");
    } else if (pathname.startsWith("/bank-reconciliation")) {
      markSeen("bankReconciliation");
    }
  }, [pathname, markSeen]);

  const badges = {
    vehicles: computeUnread("vehicles", false),
    acquisitions: canReadOperate ? computeUnread("acquisitions", false) : 0,
    customers: computeUnread("customers", false),
    approvals: (canReadManage || isOwnerUser) ? computeUnread("approvals", true) : 0,
    bankReconciliation: canReadFinance ? computeUnread("bankReconciliation", true) : 0,
  };

  const managementTotal = badges.approvals + badges.bankReconciliation;

  return {
    badges,
    managementTotal,
    markSeen,
  };
}
