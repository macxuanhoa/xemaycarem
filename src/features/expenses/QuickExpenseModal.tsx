import { useId, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { api } from "@/lib/api";
import { today } from "@/lib/format";
import { canManage } from "@/lib/permissions";
import { useAuth } from "@/features/auth/AuthProvider";
import { Button, DatePicker, ErrorState, Field } from "@/components/ui";
import { MoneyInput } from "@/components/ui/MoneyInput";
import { VEHICLE_EXPENSE_CHIPS } from "@/components/ui/QuickChips";
import { useDialog } from "@/lib/useDialog";
import { expenseSchema, vehicleExpenseLabels } from "./expenseSchema";
import { dateValue, moneyValue } from "@/lib/validation";

interface QuickExpenseModalProps {
  vehicleId: string;
  purchaseDate?: string;
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: () => void;
  initialDraft?: {
    expense_type?: string;
    description?: string;
    amount?: number;
    date?: string;
    expense_date?: string;
  };
}

export function QuickExpenseModal(props: QuickExpenseModalProps) {
  const { profile } = useAuth();
  if (!props.isOpen || !canManage(profile)) return null;
  return <QuickExpenseEditor key={props.vehicleId} {...props} />;
}

function QuickExpenseEditor({
  vehicleId,
  purchaseDate,
  onClose,
  onSuccess,
  initialDraft,
}: QuickExpenseModalProps) {
  const client = useQueryClient();
  const [type, setType] = useState(
    initialDraft?.expense_type &&
      vehicleExpenseLabels[initialDraft.expense_type]
      ? initialDraft.expense_type
      : "REPAIR",
  );
  const [chipId, setChipId] = useState(
    initialDraft?.expense_type &&
      vehicleExpenseLabels[initialDraft.expense_type]
      ? initialDraft.expense_type
      : "REPAIR",
  );
  // Nội dung để trống: chi phí luôn do người dùng tự ghi, chip chỉ chọn phân loại.
  const [description, setDescription] = useState(
    typeof initialDraft?.description === "string"
      ? initialDraft.description.slice(0, 250)
      : "",
  );
  const [amount, setAmount] = useState<number | undefined>(() => {
    const parsed = moneyValue.safeParse(initialDraft?.amount);
    return parsed.success && parsed.data > 0 ? parsed.data : undefined;
  });
  const [expenseDate, setExpenseDate] = useState(() => {
    const parsed = dateValue.safeParse(
      initialDraft?.expense_date ?? initialDraft?.date,
    );
    return parsed.success ? parsed.data : today();
  });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const amountId = useId();
  const titleId = useId();
  const saveMutation = useMutation({
    mutationFn: async () => {
      const parsed = expenseSchema.safeParse({
        vehicle_id: vehicleId,
        expense_type: type,
        description,
        amount,
        expense_date: expenseDate,
      });
      if (!parsed.success) {
        setFieldErrors(
          Object.fromEntries(
            parsed.error.issues.map((issue) => [issue.path[0], issue.message]),
          ),
        );
        throw new Error("Kiểm tra các trường được đánh dấu trước khi lưu.");
      }
      if (!vehicleExpenseLabels[type])
        throw new Error("Phân loại chi phí không hợp lệ.");
      if (purchaseDate && expenseDate < purchaseDate) {
        setFieldErrors((old) => ({
          ...old,
          expense_date: `Ngày chi không được trước ngày mua xe (${purchaseDate}).`,
        }));
        throw new Error(`Ngày chi không được trước ngày mua xe (${purchaseDate}).`);
      }
      await api.call("save_expense", {
        p_kind: "vehicle",
        p_data: parsed.data,
      });
    },
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: ["vehicle", vehicleId] }),
        client.invalidateQueries({ queryKey: ["vehicles"] }),
        client.invalidateQueries({ queryKey: ["expenses"] }),
        client.invalidateQueries({ queryKey: ["dashboard"] }),
      ]);
      onSuccess?.();
      onClose();
    },
  });
  const close = () => {
    if (!saveMutation.isPending) onClose();
  };
  const panelRef = useDialog(true, close, saveMutation.isPending);
  const selectChip = (chip: (typeof VEHICLE_EXPENSE_CHIPS)[number]) => {
    setType(chip.type);
    setChipId(chip.id);
    document.getElementById(amountId)?.focus();
  };

  return (
    <div className="modal-backdrop" onClick={close} role="presentation">
      <div
        ref={panelRef}
        tabIndex={-1}
        className="modal-card quick-expense-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="modal-header">
          <div>
            <h3 id={titleId}>+ Thêm chi phí xe</h3>
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={close}
            disabled={saveMutation.isPending}
            aria-label="Đóng"
          >
            <X size={18} />
          </button>
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setFieldErrors({});
            saveMutation.mutate();
          }}
        >
          <fieldset
            disabled={saveMutation.isPending}
            className="plain-fieldset"
          >
            <div className="modal-body stack">
              {initialDraft && (
                <p className="notice">
                  Bản nháp từ ảnh/giọng nói. Kiểm tra xe, nội dung và số tiền
                  trước khi lưu chi phí.
                </p>
              )}
              <div className="field">
                <span className="field-label">Phân loại chi phí</span>
                <div
                  className="expense-chips-grid"
                  role="group"
                  aria-label="Chọn loại chi phí"
                >
                  {VEHICLE_EXPENSE_CHIPS.map((chip) => (
                    <button
                      key={chip.id}
                      type="button"
                      className={`expense-chip-btn ${chipId === chip.id ? "active" : ""}`}
                      aria-pressed={chipId === chip.id}
                      onClick={() => selectChip(chip)}
                    >
                      {chip.label}
                    </button>
                  ))}
                </div>
              </div>
              <Field label="Số tiền chi (₫) *" error={fieldErrors.amount}>
                <MoneyInput
                  aria-label="Số tiền chi (₫) *"
                  id={amountId}
                  value={amount}
                  onChange={(value) => {
                    setAmount(value);
                    setFieldErrors((old) => ({ ...old, amount: "" }));
                  }}
                  placeholder="Ví dụ: 150k hoặc 1.200.000"
                  min={1}
                  required
                />
              </Field>
              <Field
                label="Nội dung chi tiết *"
                error={fieldErrors.description}
              >
                <input
                  value={description}
                  onChange={(event) => {
                    setDescription(event.target.value);
                    setFieldErrors((old) => ({ ...old, description: "" }));
                  }}
                  placeholder="VD: Thay lốp trước, công sửa xe, phí sang tên…"
                  maxLength={250}
                />
              </Field>
              <Field label="Ngày chi" error={fieldErrors.expense_date}>
                <DatePicker
                  min={purchaseDate}
                  max={today()}
                  value={expenseDate}
                  onChange={(val) => {
                    setExpenseDate(val);
                    setFieldErrors((old) => ({ ...old, expense_date: "" }));
                  }}
                  required
                  aria-label="Ngày chi"
                />
              </Field>
              {saveMutation.isError && (
                <ErrorState error={saveMutation.error} />
              )}
            </div>
            <div className="modal-footer">
              <Button variant="secondary" type="button" onClick={close}>
                Hủy
              </Button>
              <Button
                type="submit"
                disabled={saveMutation.isPending || !amount}
              >
                {saveMutation.isPending ? "Đang lưu…" : "Lưu chi phí"}
              </Button>
            </div>
          </fieldset>
        </form>
      </div>
    </div>
  );
}
