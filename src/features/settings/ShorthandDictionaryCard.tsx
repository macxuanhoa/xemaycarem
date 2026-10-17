/**
 * Bộ nhớ viết tắt thu xe — từ điển viết tắt theo từng tài khoản, lưu ngay
 * trên thiết bị (localStorage, không gửi đi đâu cả). Trước đây khối này nằm
 * ở trang Thu xe tốc ký kèm cơ chế "Học"; nay tách sang Cài đặt và mọi role
 * đều quản lý được quy tắc của chính mình. Trang tốc ký nạp lại từ điển này
 * khi mở, nên thêm/xoá quy tắc ở đây có hiệu lực cho lần dán kế tiếp.
 * Chỉ còn dạy viết tắt cho LOẠI XE (Màu sắc / Năm sản xuất dùng từ điển
 * mặc định của parser). Danh sách hiển thị dạng bảng thẳng hàng, kèm bản in
 * "Bảng Viết Tắt Loại Xe • Cà Rem" xuất PDF qua hộp thoại in của trình duyệt.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FileDown, X } from "lucide-react";
import { Button, Card, Field } from "@/components/ui";
import { AutocompleteInput } from "@/components/ui/AutocompleteInput";
import { useAuth } from "@/features/auth/AuthProvider";
import { api } from "@/lib/api";
import { dateLabel } from "@/lib/format";
import { toast } from "@/lib/toast";
import { type LearnedDictionary } from "@/lib/shorthand/parseIntakeNotes";
import { forgetRule, learnRule, listRules, loadDictionary } from "@/lib/shorthand/learnedDictionary";
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
  const [rule, setRule] = useState<{ key: string; value: string }>({
    key: "",
    value: "",
  });
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
      "vehicle_type",
      rule.value,
      dictionaryStorage,
    );
    if (next === dict) {
      toast.error("Chưa lưu được — cần cả viết tắt lẫn loại xe.");
      return;
    }
    setDict(next);
    setRule({ key: "", value: "" });
    toast.success("Đã lưu quy tắc viết tắt.", {
      description: "Lần dán tốc ký kế tiếp sẽ tự nhận ra từ này.",
    });
  };

  // Xuất PDF bằng cách mượn hộp thoại in của trình duyệt (không thêm thư viện):
  // đánh dấu bản in đang chọn rồi in — CSS @media print chỉ giữ lại bảng viết
  // tắt, khổ A4 gọn gàng.
  const exportPdf = () => {
    document.body.dataset.printTarget = "shorthand-dictionary";
    window.print();
    delete document.body.dataset.printTarget;
  };

  return (
    <Card>
      <h2>Bộ nhớ viết tắt thu xe</h2>
      <p className="muted small" style={{ marginBottom: "16px" }}>
        Cà Rem tra các quy tắc này khi bạn dán ghi chú ở <strong>Thu xe tốc
        ký</strong>. Bộ nhớ lưu riêng theo tài khoản trên thiết bị này, không
        chứa thông tin cá nhân và chỉ dạy viết tắt cho trường <strong>Loại
        xe</strong>.
      </p>
      <div className="settings-rule-form">
        <Field label="Viết tắt">
          <input
            value={rule.key}
            maxLength={40}
            onChange={(event) =>
              setRule({ ...rule, key: event.target.value })
            }
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                saveRule();
              }
            }}
            placeholder="VD: nxl"
          />
        </Field>
        <Field label="Thành">
          <AutocompleteInput
            aria-label="Thành"
            value={rule.value}
            onChange={(value) => setRule({ ...rule, value })}
            suggestions={typeNames}
            maxSuggestions={10}
            placeholder="VD: Honda Vision"
          />
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
        <div className="settings-rule-section">
          <div className="settings-rule-head">
            <h3>
              Quy tắc đã lưu
              <small>{rules.length} quy tắc · chỉ áp dụng cho Loại xe</small>
            </h3>
            <Button variant="secondary" onClick={exportPdf}>
              <FileDown size={14} /> Xuất PDF
            </Button>
          </div>
          <div className="settings-rule-table-wrap">
            <table className="settings-rule-table">
              <thead>
                <tr>
                  <th>Viết tắt</th>
                  <th>Được hiểu là</th>
                  <th aria-label="Thao tác" />
                </tr>
              </thead>
              <tbody>
                {rules.map((item) => (
                  <tr className="settings-rule-row" key={item.key}>
                    <td>
                      <code>{item.key}</code>
                    </td>
                    <td className="settings-rule-value">{item.value}</td>
                    <td>
                      <button
                        type="button"
                        className="settings-rule-delete"
                        aria-label={`Xoá quy tắc ${item.key}`}
                        onClick={() =>
                          setDict(
                            forgetRule(
                              profile?.id,
                              item.key,
                              dictionaryStorage,
                            ),
                          )
                        }
                      >
                        <X size={13} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted small settings-rule-export-hint">
            Nhấn <strong>Xuất PDF</strong> rồi chọn “Lưu dưới dạng PDF” trong
            hộp thoại in để giữ bảng viết tắt gọn gàng, dễ tra.
          </p>
        </div>
      )}
      {!rules.length && (
        <p className="muted small" style={{ margin: "12px 0 0" }}>
          Chưa có quy tắc nào — thêm một viết tắt ở trên để những lần dán sau
          không phải gõ lại.
        </p>
      )}
      {/* Bản in chỉ hiện khi bấm "Xuất PDF" (ẩn trên màn hình, giữ trong DOM
          cho @media print). */}
      <div className="print-shorthand-dictionary" aria-hidden="true">
        <h1>Bảng Viết Tắt Loại Xe • Cà Rem</h1>
        <p className="print-meta">
          In ngày {dateLabel(new Date().toISOString())} · {rules.length} quy
          tắc · Bộ nhớ viết tắt thu xe của tài khoản này
        </p>
        <table>
          <thead>
            <tr>
              <th className="print-col-index">STT</th>
              <th className="print-col-key">Viết tắt</th>
              <th>Được hiểu là (Loại xe)</th>
            </tr>
          </thead>
          <tbody>
            {rules.map((item, index) => (
              <tr key={item.key}>
                <td className="print-col-index">{index + 1}</td>
                <td className="print-col-key">{item.key}</td>
                <td>{item.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="print-foot">
          Bảng do Cà Rem tạo tự động — mỗi hàng là một quy tắc tra khi dán ghi
          chú ở Thu xe tốc ký.
        </p>
      </div>
    </Card>
  );
}
