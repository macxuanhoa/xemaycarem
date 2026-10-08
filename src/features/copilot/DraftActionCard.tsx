// The copilot's one-tap review-and-save handoff. Detection is deterministic and
// client-side (src/lib/shorthand/draftActions); this card only prefills the
// existing secure forms/modals — the real write still needs the human pressing
// "Lưu" inside QuickExpenseModal, the sale sheet or the shorthand intake.
import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Wand2 } from "lucide-react";
import { api } from "@/lib/api";
import { Button, Card } from "@/components/ui";
import { useAuth } from "@/features/auth/AuthProvider";
import { canManage, canOperate } from "@/lib/permissions";
import { QuickExpenseModal } from "@/features/expenses/QuickExpenseModal";
import { money } from "@/lib/format";
import { vehicleExpenseLabels } from "@/features/expenses/expenseSchema";
import type { Paged, Vehicle } from "@/types";
import type { DraftAction } from "@/lib/shorthand/draftActions";
import { vehicleSubtitle, vehicleTitle } from "@/lib/vehicleDisplay";

const summaryLabels: Record<string, string> = {
  license_plate: "Biển số",
  amount: "Số tiền",
  description: "Nội dung",
  expense_type: "Loại chi phí",
  date: "Ngày",
  customer_name: "Khách hàng",
  customer_phone: "Số điện thoại",
};

export function DraftActionCard({ action }: { action: DraftAction }) {
  const { profile } = useAuth();
  const navigate = useNavigate();
  const [expenseOpen, setExpenseOpen] = useState(false);
  const needsVehicle = action.kind !== "CREATE_ACQUISITION";
  const allowed =
    action.kind === "ADD_VEHICLE_EXPENSE"
      ? canManage(profile)
      : canOperate(profile);
  const plate = needsVehicle ? action.license_plate : null;
  const lookup = useQuery({
    queryKey: ["copilot-draft-vehicle", profile?.id, plate],
    enabled: allowed && !!plate,
    staleTime: 30_000,
    queryFn: () =>
      api.call<Paged<Vehicle>>("list_vehicles", {
        p_filters: { search: plate ?? "", limit: 5 },
      }),
  });
  const vehicle = useMemo(() => {
    const rows = lookup.data?.items ?? [];
    return rows.length === 1 ? rows[0] : null;
  }, [lookup.data]);

  if (!allowed) return null;
  const summary = Object.entries(
    action.kind === "CREATE_ACQUISITION" ? {} : action,
  ).filter(
    ([key, value]) =>
      key !== "kind" &&
      key !== "seed_text" &&
      value != null &&
      summaryLabels[key],
  );
  const title =
    action.kind === "ADD_VEHICLE_EXPENSE"
      ? "Ghi chi phí cho xe"
      : action.kind === "PREPARE_SALE"
        ? "Chuẩn bị phiếu bán xe"
        : "Thu xe tốc ký";
  return (
    <Card>
      <h2 className="section-title">
        <Wand2 size={16} aria-hidden="true" /> Cà Rem đề xuất thao tác
      </h2>
      <p className="muted">{title} từ câu bạn vừa nhập.</p>
      <dl className="summary-list">
        {summary.map(([key, value]) => (
          <div key={key}>
            <dt>{summaryLabels[key]}</dt>
            <dd>
              {key === "amount" && typeof value === "number"
                ? money(value)
                : key === "expense_type"
                  ? vehicleExpenseLabels[String(value)] || String(value)
                  : String(value)}
            </dd>
          </div>
        ))}
      </dl>
      {needsVehicle && (
        <p className="notice" role="status">
          {lookup.isFetching
            ? "Đang tìm xe theo biển số…"
            : vehicle
              ? `Khớp xe: ${vehicleTitle(vehicle)} · ${vehicleSubtitle(vehicle) || "chưa phân loại"}`
              : `Chưa khớp được xe với biển số ${plate}. Mở biểu mẫu và chọn xe thủ công.`}
        </p>
      )}
      <p className="notice">
        Bản nháp chỉ gợi ý. Kiểm tra từng trường trong biểu mẫu rồi lưu — hệ thống
        chỉ ghi nhận khi bạn xác nhận. Giá bán luôn do nhân viên tự nhập trong
        phiếu Bán xe, không lấy từ câu lệnh.
      </p>
      {action.kind === "ADD_VEHICLE_EXPENSE" && (
        <Button
          onClick={() => {
            if (vehicle) setExpenseOpen(true);
            else navigate("/expenses", { state: { aiDraft: action } });
          }}
        >
          Kiểm tra &amp; lưu chi phí
        </Button>
      )}
      {action.kind === "PREPARE_SALE" && (
        <Button
          onClick={() =>
            vehicle
              ? navigate(`/vehicles/${vehicle.id}/sell`, {
                  state: {
                    aiDraft: {
                      customer_name: action.customer_name,
                      customer_phone: action.customer_phone,
                    },
                  },
                })
              : navigate("/vehicles", { state: { aiDraft: action } })
          }
        >
          Kiểm tra &amp; mở phiếu bán
        </Button>
      )}
      {action.kind === "CREATE_ACQUISITION" && (
        <Button asChild>
          <Link to="/intake" state={{ seedText: action.seed_text }}>
            Mở thu xe tốc ký
          </Link>
        </Button>
      )}
      {action.kind === "ADD_VEHICLE_EXPENSE" &&
        vehicle &&
        expenseOpen &&
        (
          <QuickExpenseModal
            vehicleId={vehicle.id}
            vehicleName={vehicleTitle(vehicle)}
            vehicleCode={vehicle.license_plate || vehicle.frame_number}
            isOpen
            initialDraft={{
              expense_type: action.expense_type,
              description: action.description,
              amount: action.amount,
              date: action.date,
            }}
            onClose={() => setExpenseOpen(false)}
            onSuccess={() => setExpenseOpen(false)}
          />
        )}
    </Card>
  );
}
