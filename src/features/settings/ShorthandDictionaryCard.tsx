/**
 * Bộ nhớ viết tắt thu xe — từ điển viết tắt theo từng tài khoản, lưu ngay
 * trên thiết bị (localStorage, không gửi đi đâu cả). Trước đây khối này nằm
 * ở trang Thu xe tốc ký kèm cơ chế "Học"; nay tách sang Cài đặt và mọi role
 * đều quản lý được quy tắc của chính mình. Trang tốc ký nạp lại từ điển này
 * khi mở, nên thêm/xoá quy tắc ở đây có hiệu lực cho lần dán kế tiếp.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import { Button, Card, Field } from "@/components/ui";
import { AutocompleteInput } from "@/components/ui/AutocompleteInput";
import { useAuth } from "@/features/auth/AuthProvider";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import {
  INTAKE_FIELDS,
  type LearnedDictionary,
  type IntakeFieldKey,
} from "@/lib/shorthand/parseIntakeNotes";
import {
  LOCAL_LEARNING_FIELDS,
  forgetRule,
  learnRule,
  listRules,
  loadDictionary,
} from "@/lib/shorthand/learnedDictionary";
import type { Paged, Vehicle } from "@/types";

// Defer Storage getter access until the dictionary helper's guarded
// read/write — touching localStorage directly can throw before the guards.
const dictionaryStorage = {
  getItem: (key: string) => localStorage.getItem(key),
  setItem: (key: string, value: string) => localStorage.setItem(key, value),
};

export function ShorthandDictionaryCard() {
  const { profile } = useAuth();
  const [dict, setDict] = useState<LearnedDictionary>(() =>
    loadDictionary(profile?.id, dictionaryStorage),
  );
  const [rule, setRule] = useState<{
    key: string;
    field: IntakeFieldKey;
    value: string;
  }>({ key: "", field: "vehicle_type", value: "" });
  const rules = useMemo(() => listRules(dict), [dict]);

  // Gợi ý "Loại xe" lấy từ tên xe THẬT đã lưu trong Kho, giống trang tốc ký.
  const catalog = useQuery({
    queryKey: ["vehicle-form-suggestions", profile?.id],
    queryFn: () =>
      api.call<Paged<Vehicle>>("list_vehicles", {
        p_filters: { limit: 100, sort: "newest" },
      }),
    staleTime: 5 * 60 * 1000,
  });
  const typeNames = useMemo(() => {
    const seen = new Map<string, string>();
    for (const vehicle of catalog.data?.items ?? []) {
      const name = vehicle.vehicle_type?.trim();
      if (name && !seen.has(name.toLowerCase()))
        seen.set(name.toLowerCase(), name);
    }
    return [...seen.values()];
  }, [catalog.data]);

  const saveRule = () => {
    const next = learnRule(
      profile?.id,
      rule.key,
      rule.field,
      rule.value,
      dictionaryStorage,
    );
    if (next === dict) {
      toast.error("Chưa lưu được — cần cả viết tắt lẫn giá trị.");
      return;
    }
    setDict(next);
    setRule({ ...rule, key: "", value: "" });
    toast.success("Đã lưu quy tắc viết tắt.", {
      description: "Lần dán tốc ký kế tiếp sẽ tự nhận ra từ này.",
    });
  };

  return (
    <Card>
      <h2>Bộ nhớ viết tắt thu xe</h2>
      <p className="muted small" style={{ marginBottom: "16px" }}>
        Cà Rem tra các quy tắc này khi bạn dán ghi chú ở <strong>Thu xe tốc
        ký</strong>. Bộ nhớ lưu riêng theo tài khoản trên thiết bị này và không
        chứa thông tin cá nhân — chỉ nhận ba nhóm: Loại xe, Màu sắc, Năm sản
        xuất.
      </p>
      <div className="settings-rule-form">
        <Field label="Viết tắt">
          <input
            value={rule.key}
            maxLength={40}
            onChange={(event) =>
              setRule({ ...rule, key: event.target.value })
            }
            placeholder="VD: nxl"
          />
        </Field>
        <Field label="Trường điền">
          <select
            value={rule.field}
            onChange={(event) =>
              setRule({
                ...rule,
                field: event.target.value as IntakeFieldKey,
              })
            }
          >
            {INTAKE_FIELDS.filter((field) =>
              LOCAL_LEARNING_FIELDS.has(field.key),
            ).map((field) => (
              <option key={field.key} value={field.key}>
                {field.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Thành">
          {rule.field === "vehicle_type" ? (
            <AutocompleteInput
              aria-label="Thành"
              value={rule.value}
              onChange={(value) => setRule({ ...rule, value })}
              suggestions={typeNames}
              maxSuggestions={10}
              placeholder="VD: Honda Vision"
            />
          ) : (
            <input
              value={rule.value}
              maxLength={250}
              onChange={(event) =>
                setRule({ ...rule, value: event.target.value })
              }
              placeholder="Ví dụ: Đen"
            />
          )}
        </Field>
        <div className="row" style={{ gap: "8px" }}>
          <Button
            type="button"
            onClick={saveRule}
            disabled={!rule.key.trim() || !rule.value.trim()}
          >
            Lưu quy tắc
          </Button>
        </div>
      </div>
      {!!rules.length && (
        <div className="intake-rule-list">
          {rules.map((item) => (
            <span className="intake-rule-chip" key={item.key}>
              <code>{item.key}</code> → {item.value}
              <small>
                {INTAKE_FIELDS.find((f) => f.key === item.field)?.label ??
                  item.field}
              </small>
              <button
                type="button"
                aria-label={`Xoá quy tắc ${item.key}`}
                onClick={() =>
                  setDict(forgetRule(profile?.id, item.key, dictionaryStorage))
                }
              >
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
      {!rules.length && (
        <p className="muted small" style={{ margin: "12px 0 0" }}>
          Chưa có quy tắc nào — thêm một viết tắt ở trên để những lần dán sau
          không phải gõ lại.
        </p>
      )}
    </Card>
  );
}
