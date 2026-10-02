/**
 * Thu xe tốc ký — paste phone-note shorthand, review a structured list,
 * teach the tool every abbreviation you correct, then intake the whole
 * batch atomically through `import_vehicles`.
 */
import { useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  ArrowLeft,
  CheckCircle2,
  GraduationCap,
  NotebookPen,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { api } from "@/lib/api";
import { canFinance } from "@/lib/permissions";
import { money, today } from "@/lib/format";
import { toast } from "@/lib/toast";
import { Button, Card, Field, PageHeader } from "@/components/ui";
import { AutocompleteInput } from "@/components/ui/AutocompleteInput";
import { confirmAction } from "@/components/ui/ConfirmDialog";
import { useAuth } from "@/features/auth/AuthProvider";
import {
  INTAKE_FIELDS,
  parseShorthandMoney,
  parseIntakeNotes,
  type IntakeEntry,
  type IntakeFieldKey,
  type LearnedDictionary,
} from "@/lib/shorthand/parseIntakeNotes";
import {
  forgetRule,
  learnRule,
  listRules,
  loadDictionary,
} from "@/lib/shorthand/learnedDictionary";
import { normalizeKey } from "@/lib/shorthand/vocabulary";
import {
  entryToAcquisitionDraft,
  entryToImportRow,
  validateIntakeEntry,
} from "@/lib/shorthand/intakeRows";
import { vehicleSuggestions } from "@/lib/vehicleSuggestions";
import type { Paged, Vehicle } from "@/types";

type ImportIssue = { index: number; field: string; message: string };
type ImportCheck = { duplicates: ImportIssue[]; errors: ImportIssue[] };

/** Fields worth memorizing when the user types a better value than the token. */
const TEACHABLE_FIELDS = new Set<IntakeFieldKey>([
  "brand",
  "model",
  "variant",
  "color",
  "supplier_name",
]);

const SAMPLE = `sh den bs 29b1-123.45 nam 22 2v gia 18tr5
ex 155 abs xanh tm 19,5tr chu Nam sdt 0901234567
vision trang 2023 35000km 27tr niemyet 32tr`;

export default function ShorthandIntakePage() {
  const { profile } = useAuth();
  const navigate = useNavigate();
  const client = useQueryClient();
  const financial = canFinance(profile);

  const [text, setText] = useState("");
  const [entries, setEntries] = useState<IntakeEntry[]>([]);
  const [dict, setDict] = useState<LearnedDictionary>(() =>
    loadDictionary(profile?.id, localStorage),
  );
  const [dictionaryChanged, setDictionaryChanged] = useState(false);
  const [lesson, setLesson] = useState<{ key: string; field: IntakeFieldKey; value: string } | null>(null);
  const dictionaryRef = useRef<HTMLDetailsElement>(null);
  // Opening the lesson form must also expand the collapsed memory panel.
  const openLesson = (next: { key: string; field: IntakeFieldKey; value: string }) => {
    setLesson(next);
    if (dictionaryRef.current) dictionaryRef.current.open = true;
  };
  const [serverIssues, setServerIssues] = useState<Record<number, string[]>>({});

  const catalog = useQuery({
    queryKey: ["vehicle-form-suggestions", profile?.id],
    queryFn: () =>
      api.call<Paged<Vehicle>>("list_vehicles", {
        p_filters: { limit: 100, sort: "newest" },
      }),
    staleTime: 5 * 60 * 1000,
  });

  const suggestionsFor = (field: "brand" | "model" | "variant" | "color", entry: IntakeEntry) =>
    vehicleSuggestions(
      catalog.data?.items ?? [],
      field,
      profile?.id,
      field === "model" ? entry.fields.brand ?? "" : "",
    );

  const handleParse = () => {
    const parsed = parseIntakeNotes(text, dict);
    setEntries(parsed);
    setServerIssues({});
    setDictionaryChanged(false);
    if (!parsed.length)
      toast.info("Chưa tách được dòng nào. Mỗi dòng là một xe, ví dụ: \"sh đen 18tr5\".");
  };

  const updateField = (id: string, field: IntakeFieldKey, value: string) => {
    // Row indexes from a rejected server check no longer apply after an edit.
    setServerIssues({});
    setEntries((prev) =>
      prev.map((entry) =>
        entry.id === id
          ? { ...entry, fields: { ...entry.fields, [field]: value } }
          : entry,
      ),
    );
  };

  const removeEntry = (id: string) =>
    setEntries((prev) => prev.filter((entry) => entry.id !== id));

  const saveLesson = () => {
    if (!lesson || !lesson.key.trim() || !lesson.value.trim()) return;
    setDict(
      learnRule(profile?.id, lesson.key, lesson.field, lesson.value, localStorage),
    );
    setDictionaryChanged(true);
    toast.success(
      `Đã học: "${lesson.key.trim()}" = ${lesson.value.trim()} (${
        INTAKE_FIELDS.find((f) => f.key === lesson.field)?.label ?? lesson.field
      }).`,
    );
    setLesson(null);
  };

  const teachFromEdit = (entry: IntakeEntry, field: IntakeFieldKey) => {
    const token = entry.provenance[field];
    const value = entry.fields[field];
    if (!token || !value) return;
    openLesson({ key: token, field, value });
  };

  const assignTokenToNotes = (entry: IntakeEntry, token: string) => {
    const notes = entry.fields.notes ? `${entry.fields.notes} ${token}` : token;
    updateField(entry.id, "notes", notes);
    setEntries((prev) =>
      prev.map((e) =>
        e.id === entry.id
          ? { ...e, unknownTokens: e.unknownTokens.filter((t) => t !== token) }
          : e,
      ),
    );
  };

  const submit = useMutation({
    mutationFn: async () => {
      const rows = entries.map((entry) => entryToImportRow(entry, financial));
      const check = await api.call<ImportCheck>("validate_import_vehicles", {
        p_vehicles: rows,
      });
      const issues: Record<number, string[]> = {};
      for (const issue of [...check.duplicates, ...check.errors])
        (issues[issue.index] ??= []).push(issue.message);
      if (Object.keys(issues).length) {
        setServerIssues(issues);
        return { status: "invalid" as const };
      }
      setServerIssues({});
      const confirmed = await confirmAction({
        title: `Thu ${entries.length} xe vào kho?`,
        description:
          "Toàn bộ danh sách được lưu cùng lúc. Nếu có bất kỳ trùng lặp nào, hệ thống sẽ không lưu gì cả để bạn sửa lại.",
        confirmLabel: "Xác nhận thu xe",
      });
      if (!confirmed) return { status: "cancelled" as const };
      const result = await api.call<{ imported_count: number }>(
        "import_vehicles",
        { p_vehicles: rows },
      );
      return { status: "done" as const, count: result.imported_count };
    },
    onSuccess: async (outcome) => {
      if (outcome.status !== "done") return;
      toast.success(`Đã thu ${outcome.count} xe vào kho.`, {
        description: "Phiếu thu và xe đã sẵn sàng trong danh sách Thu vào.",
      });
      await client.invalidateQueries({ queryKey: ["acquisitions"] });
      await client.invalidateQueries({ queryKey: ["vehicles"] });
      await client.invalidateQueries({ queryKey: ["dashboard"] });
      navigate("/acquisitions");
    },
  });

  const clientErrorsByEntry = useMemo(
    () => entries.map((entry) => validateIntakeEntry(entry, financial)),
    [entries, financial],
  );
  const blockingCount = clientErrorsByEntry.filter((list) => list.length).length;
  const unknownCount = entries.reduce(
    (sum, entry) => sum + entry.unknownTokens.length,
    0,
  );
  const rules = listRules(dict);

  return (
    <div className="stack">
      <Link className="back-link" to="/acquisitions">
        <ArrowLeft size={16} /> Thu vào
      </Link>
      <PageHeader
        title="Thu xe tốc ký"
        description="Dán tin nhắn hoặc ghi chú viết tắt (mỗi dòng một xe). Cà Rem sẽ tách thành danh sách để bạn kiểm tra, học theo cách viết của bạn rồi thu xe hàng loạt."
      />

      <Card>
        <h2 className="section-title">
          <NotebookPen size={16} aria-hidden="true" /> 1. Dán ghi chú
        </h2>
        <textarea
          className="intake-notes"
          rows={6}
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder={SAMPLE}
          aria-label="Ghi chú tốc ký danh sách xe cần thu"
        />
        <div className="row intake-notes-actions">
          <Button type="button" onClick={handleParse} disabled={!text.trim()}>
            Tách thành danh sách
          </Button>
          <span className="muted small">
            {entries.length
              ? `${entries.length} xe đã tách · ${unknownCount} từ chưa nhận diện`
              : "Mỗi dòng một xe. Càng sửa, lần sau tách càng đúng."}
          </span>
        </div>
        {dictionaryChanged && entries.length > 0 && (
          <div className="notice" role="status">
            Bộ nhớ viết tắt vừa được cập nhật.
            <Button type="button" variant="ghost" onClick={handleParse}>
              Tách lại danh sách
            </Button>
          </div>
        )}
      </Card>

      {entries.map((entry, index) => {
        const hints = Object.entries(entry.provenance).filter(
          ([field, token]) =>
            TEACHABLE_FIELDS.has(field as IntakeFieldKey) &&
            entry.fields[field as IntakeFieldKey] &&
            normalizeKey(String(token)) !==
              normalizeKey(String(entry.fields[field as IntakeFieldKey])) &&
            String(token).length <= 24,
        ) as [IntakeFieldKey, string][];
        const issues = [
          ...clientErrorsByEntry[index],
          ...(serverIssues[index] ?? []),
        ];
        return (
          <Card key={entry.id} className={`intake-entry ${issues.length ? "has-issues" : ""}`}>
            <div className="section-heading">
              <h2 className="section-title" style={{ margin: 0 }}>
                Xe {index + 1}
                {issues.length ? <span className="intake-issue-dot" /> : null}
              </h2>
              <button
                type="button"
                className="intake-remove"
                aria-label={`Bỏ xe ${index + 1} khỏi danh sách`}
                onClick={() => removeEntry(entry.id)}
              >
                <Trash2 size={15} /> Bỏ
              </button>
            </div>
            <p className="muted small intake-source">Gốc: {entry.sourceLine}</p>
            <div className="form-grid intake-entry-grid">
              <Field label="Hãng xe *">
                <AutocompleteInput
                  value={entry.fields.brand ?? ""}
                  suggestions={suggestionsFor("brand", entry)}
                  onChange={(value) => updateField(entry.id, "brand", value)}
                  placeholder="Honda"
                />
              </Field>
              <Field label="Dòng xe *">
                <AutocompleteInput
                  value={entry.fields.model ?? ""}
                  suggestions={suggestionsFor("model", entry)}
                  onChange={(value) => updateField(entry.id, "model", value)}
                  placeholder="SH 160i"
                />
              </Field>
              <Field label="Số khung *">
                <input
                  value={entry.fields.frame_number ?? ""}
                  onChange={(event) =>
                    updateField(entry.id, "frame_number", event.target.value.toUpperCase())
                  }
                  autoCapitalize="characters"
                  placeholder="RLH160…"
                />
              </Field>
              <Field label="Biển số">
                <input
                  value={entry.fields.license_plate ?? ""}
                  onChange={(event) =>
                    updateField(entry.id, "license_plate", event.target.value.toUpperCase())
                  }
                  autoCapitalize="characters"
                  placeholder="29B1-123.45"
                />
              </Field>
              <Field label="Màu sắc">
                <AutocompleteInput
                  value={entry.fields.color ?? ""}
                  suggestions={suggestionsFor("color", entry)}
                  onChange={(value) => updateField(entry.id, "color", value)}
                  placeholder="Đen"
                />
              </Field>
              <Field label="Phiên bản">
                <AutocompleteInput
                  value={entry.fields.variant ?? ""}
                  suggestions={suggestionsFor("variant", entry)}
                  onChange={(value) => updateField(entry.id, "variant", value)}
                  placeholder="ABS"
                />
              </Field>
              {financial && (
                <Field label="Giá thu *">
                  <input
                    value={entry.fields.purchase_price ?? ""}
                    onChange={(event) =>
                      updateField(entry.id, "purchase_price", event.target.value)
                    }
                    inputMode="numeric"
                    placeholder="18tr5"
                  />
                  {moneyHint(entry.fields.purchase_price)}
                </Field>
              )}
              <Field label="Giá niêm yết">
                <input
                  value={entry.fields.asking_price ?? ""}
                  onChange={(event) =>
                    updateField(entry.id, "asking_price", event.target.value)
                  }
                  inputMode="numeric"
                  placeholder="22tr"
                />
                {moneyHint(entry.fields.asking_price)}
              </Field>
              <Field label="Năm sản xuất">
                <input
                  value={entry.fields.year ?? ""}
                  onChange={(event) => updateField(entry.id, "year", event.target.value)}
                  inputMode="numeric"
                  placeholder="2022"
                />
              </Field>
              <Field label="Số km đã đi">
                <input
                  value={entry.fields.odometer ?? ""}
                  onChange={(event) => updateField(entry.id, "odometer", event.target.value)}
                  inputMode="numeric"
                  placeholder="12000"
                />
              </Field>
              <Field label="Ngày thu">
                <input
                  type="date"
                  max={today()}
                  value={entry.fields.purchase_date ?? ""}
                  onChange={(event) =>
                    updateField(entry.id, "purchase_date", event.target.value)
                  }
                />
              </Field>
              <Field label="Số máy">
                <input
                  value={entry.fields.engine_number ?? ""}
                  onChange={(event) =>
                    updateField(entry.id, "engine_number", event.target.value.toUpperCase())
                  }
                  autoCapitalize="characters"
                  placeholder="KF160…"
                />
              </Field>
              <Field label="Tên người bán">
                <input
                  value={entry.fields.supplier_name ?? ""}
                  onChange={(event) =>
                    updateField(entry.id, "supplier_name", event.target.value)
                  }
                  placeholder="Nam"
                />
              </Field>
              <Field label="SĐT người bán">
                <input
                  value={entry.fields.supplier_phone ?? ""}
                  onChange={(event) =>
                    updateField(entry.id, "supplier_phone", event.target.value)
                  }
                  inputMode="tel"
                  placeholder="0901234567"
                />
              </Field>
            </div>
            <Field label="Ghi chú">
              <textarea
                rows={2}
                value={entry.fields.notes ?? ""}
                onChange={(event) => updateField(entry.id, "notes", event.target.value)}
                placeholder="Tình trạng, giấy tờ, phụ kiện…"
              />
            </Field>

            {(entry.unknownTokens.length > 0 || hints.length > 0) && (
              <div className="intake-learn-strip">
                {entry.unknownTokens.map((token) => (
                  <span className="intake-token-chip" key={token}>
                    <code>{token}</code>
                    <button type="button" onClick={() => assignTokenToNotes(entry, token)}>
                      + Ghi chú
                    </button>
                    <button
                      type="button"
                      className="teach"
                      onClick={() =>
                        openLesson({ key: token, field: "model", value: "" })
                      }
                    >
                      <GraduationCap size={13} /> Học
                    </button>
                  </span>
                ))}
                {hints.map(([field, token]) => (
                  <button
                    type="button"
                    className="intake-hint"
                    key={`${field}:${token}`}
                    onClick={() => teachFromEdit(entry, field)}
                  >
                    <Plus size={13} /> Học: “{token}” = “
                    {entry.fields[field]}”?
                  </button>
                ))}
              </div>
            )}

            {!!issues.length && (
              <ul className="intake-entry-issues" role="alert">
                {issues.map((message) => (
                  <li key={message}>{message}</li>
                ))}
              </ul>
            )}
            <div className="row" style={{ gap: "8px" }}>
              <Button
                type="button"
                variant="secondary"
                disabled={!entry.fields.frame_number || !entry.fields.brand || !entry.fields.model}
                onClick={() =>
                  navigate("/acquisitions/new", {
                    state: { aiDraft: entryToAcquisitionDraft(entry) },
                  })
                }
              >
                Mở biểu mẫu thu xe
              </Button>
            </div>
          </Card>
        );
      })}

      {!!entries.length && (
        <Card className="intake-confirm">
          <div className="section-heading">
            <h2 className="section-title" style={{ margin: 0 }}>
              2. Xác nhận thu hàng loạt
            </h2>
            <span className="muted small">{entries.length} xe trong danh sách</span>
          </div>
          {blockingCount > 0 && (
            <p className="notice danger" role="status">
              {blockingCount} xe còn thiếu thông tin bắt buộc (số khung, hãng, dòng
              xe{financial ? ", giá thu" : ""}). Xem cảnh báo đỏ ở từng thẻ xe.
            </p>
          )}
          {unknownCount > 0 && (
            <p className="muted small">
              Còn {unknownCount} từ chưa nhận diện — gán vào ghi chú hoặc dạy Cà Rem
              để lần sau tự hiểu.
            </p>
          )}
          <div className="form-actions">
            <Button
              type="button"
              disabled={
                blockingCount > 0 || submit.isPending || !entries.length
              }
              onClick={() => void submit.mutate()}
            >
              {submit.isPending ? (
                "Đang kiểm tra & lưu…"
              ) : (
                <>
                  <CheckCircle2 size={16} /> Thu {entries.length} xe vào kho
                </>
              )}
            </Button>
          </div>
          {submit.isError && (
            <p className="notice danger">
              {submit.error instanceof Error
                ? submit.error.message
                : "Chưa lưu được. Kiểm tra kết nối rồi thử lại."}
            </p>
          )}
        </Card>
      )}

      <Card className="intake-dictionary">
        <details ref={dictionaryRef}>
          <summary>
            <GraduationCap size={15} aria-hidden="true" /> Bộ nhớ viết tắt của bạn
            ({rules.length})
          </summary>
          <p className="muted small">
            Cà Rem học riêng theo tài khoản của bạn và lưu trên thiết bị này. Mỗi
            lần bạn sửa hoặc dạy một từ viết tắt, lần dán sau sẽ tự đúng hơn.
          </p>
          {lesson && (
            <div className="intake-lesson-form">
              <Field label="Viết tắt">
                <input
                  value={lesson.key}
                  onChange={(event) => setLesson({ ...lesson, key: event.target.value })}
                  autoFocus
                />
              </Field>
              <Field label="Trường điền">
                <select
                  value={lesson.field}
                  onChange={(event) =>
                    setLesson({ ...lesson, field: event.target.value as IntakeFieldKey })
                  }
                >
                  {INTAKE_FIELDS.map((field) => (
                    <option key={field.key} value={field.key}>
                      {field.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Thành">
                <input
                  value={lesson.value}
                  onChange={(event) => setLesson({ ...lesson, value: event.target.value })}
                  placeholder="Ví dụ: Wave RSX"
                />
              </Field>
              <div className="row" style={{ gap: "8px" }}>
                <Button type="button" onClick={saveLesson} disabled={!lesson.value.trim()}>
                  Lưu quy tắc
                </Button>
                <Button type="button" variant="ghost" onClick={() => setLesson(null)}>
                  <X size={14} /> Đóng
                </Button>
              </div>
            </div>
          )}
          {!!rules.length && (
            <div className="intake-rule-list">
              {rules.map((rule) => (
                <span className="intake-rule-chip" key={rule.key}>
                  <code>{rule.key}</code> → {rule.value}
                  <small>
                    {INTAKE_FIELDS.find((f) => f.key === rule.field)?.label ?? rule.field}
                  </small>
                  <button
                    type="button"
                    aria-label={`Quên quy tắc ${rule.key}`}
                    onClick={() => setDict(forgetRule(profile?.id, rule.key, localStorage))}
                  >
                    <X size={12} />
                  </button>
                </span>
              ))}
            </div>
          )}
        </details>
      </Card>
    </div>
  );
}

function moneyHint(raw?: string) {
  if (!raw?.trim()) return null;
  const value = parseShorthandMoney(raw);
  if (value === null)
    return <span className="intake-money-hint danger">Chưa hiểu số tiền này</span>;
  return <span className="intake-money-hint">= {money(value)}</span>;
}
