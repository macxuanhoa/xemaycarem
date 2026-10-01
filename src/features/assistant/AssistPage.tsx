import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Button, Card, ErrorState, Field, PageHeader } from "@/components/ui";
import { useAuth } from "@/features/auth/AuthProvider";
import { canManage, canOperate } from "@/lib/permissions";
import { QuickExpenseModal } from "@/features/expenses/QuickExpenseModal";
import type { Vehicle } from "@/types";
import { dateLabel, money } from "@/lib/format";
import { actionLabels } from "@/features/vehicles/vehicleSchema";

type Task =
  | "business_question"
  | "vehicle_document"
  | "license_plate"
  | "odometer"
  | "receipt"
  | "voice";
type AssistResult =
  | {
      kind: "draft";
      task: Task;
      vehicle_id: string | null;
      draft: Record<string, string | number | null>;
      human_confirmation_required: true;
      warnings: string[];
    }
  | { kind: "read_result"; facts: Record<string, unknown>; source: string };
type Recognition = {
  lang: string;
  interimResults: boolean;
  onresult:
    | ((event: {
        results: {
          [index: number]: { [index: number]: { transcript: string } };
        };
      }) => void)
    | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
};
const tasks: Record<Task, string> = {
  business_question: "Hỏi dữ liệu cửa hàng",
  vehicle_document: "Đọc giấy tờ xe",
  license_plate: "Đọc biển số",
  odometer: "Đọc đồng hồ km",
  receipt: "Đọc hóa đơn chi phí",
  voice: "Chuẩn bị bản nháp từ lời nói",
};
const labels: Record<string, string> = {
  frame_number: "Số khung",
  engine_number: "Số máy",
  license_plate: "Biển số",
  brand: "Hãng",
  model: "Dòng xe",
  color: "Màu",
  year: "Năm",
  amount: "Số tiền (₫)",
  date: "Ngày",
  merchant: "Đơn vị cung cấp",
  description: "Nội dung",
  expense_type: "Loại chi phí",
  intent: "Thao tác đề xuất",
  odometer: "Số km",
  purchase_price: "Giá mua đề xuất (₫)",
  sale_price: "Giá bán đề xuất (₫)",
};
const imageTasks = ["vehicle_document", "license_plate", "odometer", "receipt"];
const draftValues: Record<string, string> = {
  CREATE_ACQUISITION: "Thu xe",
  ADD_VEHICLE_EXPENSE: "Thêm chi phí",
  PREPARE_SALE: "Chuẩn bị bán xe",
  UNKNOWN: "Chưa xác định",
  REPAIR: "Sửa chữa",
  TRANSPORT: "Vận chuyển",
  PAPERWORK: "Giấy tờ",
  PARTS: "Phụ tùng",
  CLEANING: "Vệ sinh",
  INSPECTION: "Kiểm tra",
  OTHER: "Khác",
};

function BusinessFacts({ facts }: { facts: Record<string, unknown> }) {
  const metrics: Record<string, string> = {
    in_stock: "Xe tồn kho",
    reserved: "Xe giữ chỗ",
    acquisitions_count: "Xe thu trong kỳ",
    sales_count: "Xe bán trong kỳ",
    revenue: "Doanh thu",
    gross_profit: "Lợi nhuận gộp",
    old_inventory_count: "Xe tồn trên 60 ngày",
    total: "Kết quả tìm thấy",
  };
  const rows = (key: string) =>
    Array.isArray(facts[key])
      ? (facts[key] as unknown[])
          .filter(
            (row): row is Record<string, unknown> =>
              !!row && typeof row === "object",
          )
          .slice(0, 25)
      : [];
  if (facts.available === false)
    return <p>Dữ liệu chưa sẵn sàng cho câu hỏi này.</p>;
  return (
    <div className="stack">
      {typeof facts.month === "string" && <p>Kỳ: {facts.month}</p>}
      <dl className="summary-list">
        {Object.entries(metrics)
          .filter(([key]) => typeof facts[key] === "number")
          .map(([key, label]) => (
            <div key={key}>
              <dt>{label}</dt>
              <dd>
                {["revenue", "gross_profit"].includes(key)
                  ? money(facts[key] as number)
                  : String(facts[key])}
              </dd>
            </div>
          ))}
      </dl>
      {[...rows("matches"), ...rows("longest_stock")].map((row, index) => (
        <div className="compact-row" key={index}>
          <strong>
            {String(row.brand || "")} {String(row.model || "")}
          </strong>
          <span>
            {String(row.license_plate || row.internal_code || "")} ·{" "}
            {String(row.frame_number || "")}
          </span>
          {typeof row.days_in_inventory === "number" && (
            <small>{row.days_in_inventory} ngày trong kho</small>
          )}
        </div>
      ))}
      {rows("aging").map((row, index) => (
        <p key={index}>
          {String(row.bucket || "")}: {String(row.count || 0)} xe
        </p>
      ))}
      {rows("expenses").map((row, index) => (
        <div className="compact-row" key={index}>
          <span>
            {String(row.description || "")} ·{" "}
            {typeof row.expense_date === "string"
              ? dateLabel(row.expense_date)
              : ""}
          </span>
          <strong>
            {typeof row.amount === "number" ? money(row.amount) : "—"}
          </strong>
        </div>
      ))}
      {rows("history").map((row, index) => (
        <div className="compact-row" key={index}>
          <span>{actionLabels[String(row.action)] || "Thao tác với xe"}</span>
          <small>
            {typeof row.created_at === "string"
              ? dateLabel(row.created_at)
              : ""}
          </small>
        </div>
      ))}
    </div>
  );
}

export default function AssistPage() {
  const { profile } = useAuth();
  const [params] = useSearchParams();
  const initialTask = params.get("task");
  const [task, setTask] = useState<Task>(
    initialTask && Object.hasOwn(tasks, initialTask) && (initialTask === "business_question" || (initialTask === "receipt" ? canManage(profile) : canOperate(profile)))
      ? (initialTask as Task)
      : "business_question",
  );
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState("");
  const [consent, setConsent] = useState(false);
  const [localError, setLocalError] = useState<unknown>(null);
  const [expenseOpen, setExpenseOpen] = useState(false);
  const [listening, setListening] = useState(false);
  const recognition = useRef<Recognition | null>(null);
  const vehicleId = params.get("vehicle");
  const vehicle = useQuery({
    queryKey: ["vehicle", vehicleId],
    queryFn: () => api.call<Vehicle>("get_vehicle", { p_id: vehicleId }),
    enabled: !!vehicleId,
  });
  useEffect(() => {
    if (!file) {
      setPreview("");
      return;
    }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  useEffect(
    () => () => {
      recognition.current?.stop();
    },
    [],
  );
  const mutation = useMutation({
    mutationFn: async () => {
      let image: { mime_type: string; base64: string } | undefined;
      if (file) {
        const data = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result).split(",")[1]);
          reader.onerror = () => reject(new Error("Không đọc được ảnh."));
          reader.readAsDataURL(file);
        });
        image = { mime_type: file.type, base64: data };
      }
      return api.assist<AssistResult>({
        task,
        consent,
        text: imageTasks.includes(task) ? undefined : text.trim() || undefined,
        image: imageTasks.includes(task) ? image : undefined,
        vehicle_id: vehicleId || undefined,
      });
    },
  });
  const voice = () => {
    const browser = window as unknown as {
      SpeechRecognition?: new () => Recognition;
      webkitSpeechRecognition?: new () => Recognition;
    };
    const Speech = browser.SpeechRecognition || browser.webkitSpeechRecognition;
    if (!Speech) {
      setLocalError(
        new Error(
          "Trình duyệt chưa hỗ trợ giọng nói. Bạn có thể gõ vào ô bên dưới.",
        ),
      );
      return;
    }
    if (listening) {
      recognition.current?.stop();
      return;
    }
    const reader = new Speech();
    recognition.current = reader;
    reader.lang = "vi-VN";
    reader.interimResults = false;
    reader.onresult = (event) => {
      setText(event.results[0][0].transcript);
      setListening(false);
    };
    reader.onerror = () => {
      setListening(false);
      setLocalError(
        new Error(
          "Chưa nhận được giọng nói. Kiểm tra quyền micro hoặc nhập bằng bàn phím.",
        ),
      );
    };
    reader.onend = () => setListening(false);
    try {
      setListening(true);
      reader.start();
    } catch {
      setListening(false);
      setLocalError(
        new Error("Không mở được micro. Bạn có thể nhập bằng bàn phím."),
      );
    }
  };
  const result = mutation.data;
  const draft = result?.kind === "draft" ? result.draft : null;
  return (
    <div className="stack">
      <PageHeader
        title="Hỏi Cà Rem / Chuẩn bị bản nháp"
        description="Đọc dữ liệu theo quyền của bạn. Bản nháp cần kiểm tra trong biểu mẫu trước khi lưu."
      />
      <Card>
        <form
          className="stack"
          onSubmit={(event) => {
            event.preventDefault();
            if (consent) mutation.mutate();
          }}
        >
          <Field label="Bạn muốn làm gì?">
            <select
              disabled={mutation.isPending}
              value={task}
              onChange={(event) => {
                setTask(event.target.value as Task);
                mutation.reset();
                setFile(null);
                setConsent(false);
              }}
            >
              {Object.entries(tasks)
                .filter(
                  ([key]) => key === "business_question" || (key === "receipt" ? canManage(profile) : canOperate(profile)),
                )
                .map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
            </select>
          </Field>
          {vehicle.data && (
            <p className="notice">
              Xe đang chọn: {vehicle.data.brand} {vehicle.data.model} ·{" "}
              {vehicle.data.license_plate || vehicle.data.frame_number}
            </p>
          )}
          {!imageTasks.includes(task) && (
            <Field
              label={
                task === "business_question" ? "Câu hỏi" : "Nội dung / ghi chú"
              }
            >
              <textarea
                disabled={mutation.isPending}
                rows={3}
                value={text}
                maxLength={2000}
                onChange={(event) => { setText(event.target.value); mutation.reset(); }}
                placeholder={
                  task === "business_question"
                    ? "Tháng này bán bao nhiêu xe?"
                    : "Nhập lời nói hoặc thông tin cần đọc từ ảnh"
                }
              />
            </Field>
          )}
          {task === "voice" && (
            <Button type="button" variant="secondary" onClick={voice}>
              {listening ? "Dừng micro" : "Nhập giọng nói bằng trình duyệt"}
            </Button>
          )}
          {[
            "vehicle_document",
            "license_plate",
            "odometer",
            "receipt",
          ].includes(task) && (
            <Field label="Ảnh cần đọc (JPG, PNG, WebP tối đa 2 MB)">
              <input
                type="file"
                disabled={mutation.isPending}
                accept="image/jpeg,image/png,image/webp"
                capture="environment"
                onChange={(event) => {
                  const chosen = event.target.files?.[0];
                  setLocalError(null);
                  if (!chosen) return;
                  if (
                    chosen.size > 2 * 1024 * 1024 ||
                    !["image/jpeg", "image/png", "image/webp"].includes(
                      chosen.type,
                    )
                  ) {
                    setFile(null); mutation.reset();
                    setLocalError(
                      new Error("Chọn ảnh JPG, PNG hoặc WebP tối đa 2 MB."),
                    );
                    return;
                  }
                  setFile(chosen);
                  mutation.reset();
                }}
              />
            </Field>
          )}
          {preview && (
            <img
              className="assist-preview"
              src={preview}
              alt="Ảnh đang chuẩn bị đọc"
            />
          )}
          <label className="row">
            <input
              type="checkbox"
              checked={consent}
              disabled={mutation.isPending}
              onChange={(event) => setConsent(event.target.checked)}
            />
            Cho phép gửi nội dung và ảnh đang chọn tới dịch vụ xử lý. Kiểm tra,
            che thông tin cá nhân không cần thiết trước khi gửi.
          </label>
          <Button
            type="submit"
            disabled={
              !consent ||
              mutation.isPending ||
              (imageTasks.includes(task) ? !file : !text.trim())
            }
          >
            {mutation.isPending
              ? "Đang xử lý…"
              : task === "business_question"
                ? "Tra cứu dữ liệu"
                : "Chuẩn bị bản nháp"}
          </Button>
          {localError != null && <ErrorState error={localError} />}
          {mutation.error && (
            <>
              <ErrorState error={mutation.error} />
              <p className="muted">
                Nếu dịch vụ chưa được bật, bạn vẫn có thể tìm xe và nhập biểu
                mẫu thông thường.
              </p>
            </>
          )}
        </form>
      </Card>
      {result?.kind === "read_result" && (
        <Card>
          <h2 className="section-title">Dữ liệu cửa hàng</h2>
          <BusinessFacts facts={result.facts} />
          <p className="muted">
            Dữ liệu từ hệ thống theo quyền tài khoản; không suy đoán khi dữ liệu
            không có.
          </p>
        </Card>
      )}
      {draft && (
        <Card>
          <h2 className="section-title">Kiểm tra bản nháp</h2>
          <dl className="summary-list">
            {Object.entries(draft)
              .filter(([, value]) => value != null)
              .map(([key, value]) => (
                <div key={key}>
                  <dt>{labels[key] || key}</dt>
                  <dd>
                    {["amount", "purchase_price", "sale_price"].includes(key) &&
                    typeof value === "number"
                      ? money(value)
                      : draftValues[String(value)] || String(value)}
                  </dd>
                </div>
              ))}
          </dl>
          {result?.kind === "draft" &&
            result.warnings.map((warning) => (
              <p className="notice" key={warning}>
                {warning}
              </p>
            ))}
          {task === "odometer" &&
            vehicle.data &&
            typeof draft.odometer === "number" &&
            draft.odometer < vehicle.data.odometer && (
              <p className="notice">
                Số km đọc được thấp hơn số đã ghi nhận ({vehicle.data.odometer}{" "}
                km). Kiểm tra lại ảnh và đồng hồ.
              </p>
            )}
          <p className="notice">
            Ảnh hoặc lời nói có thể được nhận sai. Kiểm tra số khung, số tiền,
            ngày và xe trước khi xác nhận.
          </p>
          {(task === "vehicle_document" ||
            draft.intent === "CREATE_ACQUISITION") &&
            canOperate(profile) && (
              <Button asChild>
                <Link to="/acquisitions/new" state={{ aiDraft: draft }}>
                  Kiểm tra trong phiếu thu xe
                </Link>
              </Button>
            )}
          {(task === "receipt" || draft.intent === "ADD_VEHICLE_EXPENSE") &&
            canManage(profile) &&
            vehicle.data && (
              <Button onClick={() => setExpenseOpen(true)}>
                Kiểm tra chi phí cho xe đang chọn
              </Button>
            )}
          {task === "license_plate" &&
            typeof draft.license_plate === "string" && (
              <Button asChild variant="secondary">
                <Link
                  to={`/vehicles?q=${encodeURIComponent(draft.license_plate)}`}
                >
                  Tìm xe theo biển số đã kiểm tra
                </Link>
              </Button>
            )}
          {task === "odometer" && vehicle.data && (
            <Button asChild variant="secondary">
              <Link to={`/vehicles/${vehicle.data.id}/edit`}>
                Mở xe để kiểm tra số km
              </Link>
            </Button>
          )}
          {draft.intent === "PREPARE_SALE" &&
            vehicle.data &&
            canOperate(profile) && (
              <Button asChild variant="secondary">
                <Link to={`/vehicles/${vehicle.data.id}/sell`}>
                  Mở phiếu bán xe để kiểm tra
                </Link>
              </Button>
            )}
        </Card>
      )}
      <div className="row">
        <Button asChild variant="secondary">
          <Link to="/vehicles">Tìm xe</Link>
        </Button>
        {canOperate(profile) && (
          <Button asChild variant="secondary">
            <Link to="/acquisitions/new">Thu xe bằng biểu mẫu</Link>
          </Button>
        )}
      </div>
      {expenseOpen && vehicle.data && draft && (
        <QuickExpenseModal
          vehicleId={vehicle.data.id}
          vehicleName={`${vehicle.data.brand} ${vehicle.data.model}`}
          vehicleCode={vehicle.data.license_plate || vehicle.data.frame_number}
          isOpen
          initialDraft={{
            expense_type:
              typeof draft.expense_type === "string"
                ? draft.expense_type
                : undefined,
            description:
              typeof draft.description === "string"
                ? draft.description
                : undefined,
            amount: typeof draft.amount === "number" ? draft.amount : undefined,
            date: typeof draft.date === "string" ? draft.date : undefined,
          }}
          onClose={() => setExpenseOpen(false)}
        />
      )}
    </div>
  );
}
