/**
 * Thu xe tốc ký — paste phone-note shorthand, review a structured list,
 * teach the tool every abbreviation you correct, then intake the whole
 * batch atomically through `import_vehicles`.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  CheckCircle2,
  ClipboardPaste,
  GraduationCap,
  NotebookPen,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { api } from "@/lib/api";
import { AppError, friendlyError } from "@/lib/errors";
import { executeOperation, reconcileOperation } from "@/lib/operationRecovery";
import { OperationRecoveryNotice } from "@/components/OperationRecoveryNotice";
import { isoToDisplayDate, displayToIsoDate, today } from "@/lib/format";
import { MoneyInput } from "@/components/ui/MoneyInput";
import { parseMoneyInput } from "@/lib/moneyHelper";
import { canonicalizePlate, PLATE_EXAMPLE } from "@/lib/plate";
import { toast } from "@/lib/toast";
import {
  Button,
  Card,
  ColorSwatchAction,
  Field,
  PageHeader,
} from "@/components/ui";
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
  LOCAL_LEARNING_FIELDS,
} from "@/lib/shorthand/learnedDictionary";
import { normalizeKey } from "@/lib/shorthand/vocabulary";
import {
  entryToAcquisitionDraft,
  entryToImportRow,
  validateIntakeEntry,
} from "@/lib/shorthand/intakeRows";
import { vehicleSuggestions } from "@/lib/vehicleSuggestions";
import {
  parseRecognition,
  readRecognitionDraft,
  recognitionToIntakeEntry,
  clearRecognitionDraft,
} from "@/lib/smartcam/recognition";
import { uploadEntryPhotos } from "@/lib/smartcam/photos";
import type { Paged, Vehicle } from "@/types";
import { normalizeVehicleYear } from "@/lib/vehicleInputFormatting";
import { compactFrame, frameKindFromCompact } from "@/lib/frameNumber";

/**
 * Nhãn loại dữ liệu số khung cho thẻ tốc ký: mảnh rút gọn (< 11 ký tự chữ+số)
 * được đánh dấu rõ để nhân viên biết giá trị này chỉ phục vụ phát hiện nghi
 * trùng, không phải VIN đầy đủ. Khung trống hoặc VIN đủ dài → không gắn nhãn.
 */
function frameKindLabelOf(frame: string | undefined): string {
  const compact = compactFrame(frame ?? "");
  if (!compact) return "";
  return frameKindFromCompact(compact) === "PARTIAL"
    ? "Rút gọn · chưa phải VIN đầy đủ"
    : "";
}

type ImportIssue = { index: number; field: string; message: string };
type ImportCheck = { duplicates: ImportIssue[]; errors: ImportIssue[] };

// Review controls reject ambiguous punctuation while retaining established
// Vietnamese shorthand such as18tr5. The import parser and payload stay unchanged.
function parseReviewedIntakeMoney(text: string): number | undefined {
  const strict = parseMoneyInput(text);
  if (strict != null) return strict;
  const normalized = normalizeKey(text)
    .replace(/\s+/g, "")
    .replaceAll("trieu", "tr")
    .replaceAll("nghin", "k")
    .replaceAll("ngan", "k");
  return /^\d+(?:[.,]\d{1,6})?(?:k|tr|m|ty|b)\d{0,2}$/.test(normalized)
    ? (parseShorthandMoney(text) ?? undefined)
    : undefined;
}

/** Fields worth memorizing when the user types a better value than the token. */
const TEACHABLE_FIELDS = new Set<IntakeFieldKey>([
  "vehicle_type",
  "color",
  "year",
]);

// Defer Storage getter access until the dictionary helper's guarded read/write.
// Passing localStorage directly can throw before those guards are entered.
const dictionaryStorage = {
  getItem: (key: string) => localStorage.getItem(key),
  setItem: (key: string, value: string) => localStorage.setItem(key, value),
};

/** ISO (yyyy-mm-dd) → "dd/mm/yyyy" for display; partial user text passes through. */
function dateDisplay(raw: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? isoToDisplayDate(raw) : raw;
}
/** Parse user text (dd/mm/yy or dd/mm/yyyy) back to ISO on blur. */
function dateBlur(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  const m = trimmed.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/);
  if (!m) return trimmed;
  let year = m[3];
  if (year.length === 2) year = (+year > 80 ? "19" : "20") + year;
  return displayToIsoDate(`${m[1]}/${m[2]}/${year}`) || trimmed;
}

export default function ShorthandIntakePage() {
  const { profile } = useAuth();
  const navigate = useNavigate();
  const client = useQueryClient();
  // Copilot handoff: a command sentence can seed the notes box and auto-parse.
  const location = useLocation();
  const seedText =
    typeof (location.state as { seedText?: unknown } | null)?.seedText ===
    "string"
      ? String((location.state as { seedText: string }).seedText).slice(0, 4000)
      : "";
  // Smart Camera handoff: one structured recognition result becomes one
  // reviewed intake entry — no parallel form, no second save path.
  const cameraRecognition = parseRecognition(
    (location.state as { recognition?: unknown } | null)?.recognition,
  );

  const [entries, setEntries] = useState<IntakeEntry[]>(() => {
    if (!cameraRecognition) return [];
    const entry = recognitionToIntakeEntry(
      cameraRecognition,
      crypto.randomUUID?.() ?? `cam-${Date.now()}`,
      today(),
    );
    if (cameraRecognition.photos.length)
      entry.photos = cameraRecognition.photos;
    return [entry];
  });
  const [dict, setDict] = useState<LearnedDictionary>(() =>
    loadDictionary(profile?.id, dictionaryStorage),
  );
  const [dictionaryChanged, setDictionaryChanged] = useState(false);
  const [lesson, setLesson] = useState<{
    key: string;
    field: IntakeFieldKey;
    value: string;
  } | null>(null);
  const dictionaryRef = useRef<HTMLDetailsElement>(null);
  const notesRef = useRef<HTMLTextAreaElement>(null);
  // Opening the lesson form must also expand the collapsed memory panel.
  const openLesson = (next: {
    key: string;
    field: IntakeFieldKey;
    value: string;
  }) => {
    setLesson(next);
    if (dictionaryRef.current) dictionaryRef.current.open = true;
  };
  const [serverIssues, setServerIssues] = useState<Record<number, string[]>>(
    {},
  );

  const [text, setText] = useState(seedText);
  const entriesEdited = useRef(false);
  // Interruption safety: a camera result that never reached the form (page
  // reload, crash) is restored once from the session draft.
  const didRestoreCamera = useRef(false);
  useEffect(() => {
    if (didRestoreCamera.current || cameraRecognition || !profile?.id) return;
    didRestoreCamera.current = true;
    if (seedText) return;
    const stored = readRecognitionDraft(profile.id);
    if (!stored) return;
    const entry = recognitionToIntakeEntry(
      stored,
      crypto.randomUUID?.() ?? `cam-${Date.now()}`,
      today(),
    );
    setEntries((prev) => (prev.length ? prev : [entry]));
  }, [cameraRecognition, profile?.id, seedText]);

  const catalog = useQuery({
    queryKey: ["vehicle-form-suggestions", profile?.id],
    queryFn: () =>
      api.call<Paged<Vehicle>>("list_vehicles", {
        p_filters: { limit: 100, sort: "newest" },
      }),
    staleTime: 5 * 60 * 1000,
  });

  const suggestions = (field: "color" | "vehicle_type") =>
    vehicleSuggestions(catalog.data?.items ?? [], field, profile?.id);

  // Gợi ý "Loại xe" lấy từ tên xe THẬT đã lưu trong Kho (DISTINCT), không phải
  // danh mục seed. parser tốc ký cũng dùng chính danh sách tên này để nhận token.
  const typeNames = useMemo(() => {
    const seen = new Map<string, string>();
    for (const vehicle of catalog.data?.items ?? []) {
      const name = vehicle.vehicle_type?.trim();
      if (name && !seen.has(name.toLowerCase()))
        seen.set(name.toLowerCase(), name);
    }
    return [...seen.values()];
  }, [catalog.data]);

  const handleParse = async () => {
    if (
      entries.length &&
      (entriesEdited.current || entries.some((entry) => entry.photos?.length))
    ) {
      const confirmed = await confirmAction({
        title: "Tách lại danh sách xe?",
        description:
          "Các thông tin đã sửa và ảnh trong danh sách hiện tại sẽ được thay bằng nội dung ghi chú. Bạn có thể ở lại để kiểm tra trước.",
        confirmLabel: "Tách lại danh sách",
        cancelLabel: "Giữ danh sách hiện tại",
      });
      if (!confirmed) return;
    }
    entriesEdited.current = false;
    const currentDate = today();
    const parsed = parseIntakeNotes(text, dict, typeNames).map((entry) => ({
      ...entry,
      fields: {
        ...entry.fields,
        purchase_date: entry.fields.purchase_date ?? currentDate,
      },
    }));
    setEntries(parsed);
    setServerIssues({});
    setDictionaryChanged(false);
    if (!parsed.length)
      toast.info(
        'Chưa tách được dòng nào. Mỗi dòng là một xe, ví dụ: "tay ga den 18tr5".',
      );
  };

  const didAutoParse = useRef(false);
  useEffect(() => {
    if (!seedText || didAutoParse.current) return;
    didAutoParse.current = true;
    const currentDate = today();
    setEntries(
      parseIntakeNotes(seedText, dict, typeNames).map((entry) => ({
        ...entry,
        fields: {
          ...entry.fields,
          purchase_date: entry.fields.purchase_date ?? currentDate,
        },
      })),
    );
  }, [seedText, dict, typeNames]);

  const handlePasteClipboard = async () => {
    try {
      const clipboardText = await navigator.clipboard.readText();
      if (!clipboardText.trim()) {
        toast.info("Clipboard đang trống.");
        return;
      }
      setText(clipboardText);
      requestAnimationFrame(() => notesRef.current?.focus());
      toast.success("Đã dán ghi chú từ clipboard.");
    } catch {
      toast.error("Chưa đọc được clipboard. Hãy dán trực tiếp vào ô ghi chú.");
    }
  };

  const updateField = (id: string, field: IntakeFieldKey, value: string) => {
    entriesEdited.current = true;
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
      learnRule(
        profile?.id,
        lesson.key,
        lesson.field,
        lesson.value,
        dictionaryStorage,
      ),
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
      if (!profile)
        throw new AppError("Vui lòng đăng nhập lại trước khi thu xe.");
      const previous = await reconcileOperation<{
        imported_count: number;
        vehicle_ids?: string[];
      }>(profile.id, "import_vehicles", "batch");
      if (previous.confirmed) {
        // The stored receipt replays the same vehicle_ids the write returned,
        // so even recovery after a lost response attaches photos by id.
        const recovered = await uploadEntryPhotos(
          entries,
          previous.result?.vehicle_ids,
        );
        return {
          status: "done" as const,
          count: previous.result!.imported_count,
          photos: recovered,
        };
      }
      const rows = entries.map((entry) => entryToImportRow(entry));
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
      const result = await executeOperation<{
        imported_count: number;
        vehicle_ids?: string[];
      }>(profile.id, "import_vehicles", "batch", (requestId) =>
        api.call("import_vehicles", {
          p_vehicles: { rows, request_id: requestId },
        }),
      );
      // Camera photos go through the normal secure upload only after the
      // confirmed write — a failed import can never leave stray images.
      const photos = await uploadEntryPhotos(entries, result.vehicle_ids);
      return { status: "done" as const, count: result.imported_count, photos };
    },
    onSuccess: async (outcome) => {
      if (outcome.status !== "done") return;
      clearRecognitionDraft(profile?.id);
      toast.success(`Đã thu ${outcome.count} xe vào kho.`, {
        description: "Phiếu thu và xe đã sẵn sàng trong danh sách Thu vào.",
      });
      if (outcome.photos.uploaded)
        toast.success(
          `Đã đính ${outcome.photos.uploaded} ảnh camera vào xe mới.`,
        );
      if (outcome.photos.failed)
        toast.info(
          `${outcome.photos.failed} ảnh chưa tải lên được — mở chi tiết xe để thêm ảnh.`,
        );
      await client.invalidateQueries({ queryKey: ["acquisitions"] });
      await client.invalidateQueries({ queryKey: ["vehicles"] });
      await client.invalidateQueries({ queryKey: ["dashboard"] });
      navigate("/acquisitions");
    },
  });

  const clientErrorsByEntry = useMemo(
    () => entries.map((entry) => validateIntakeEntry(entry)),
    [entries],
  );
  // Smart Camera provenance badges: only camera entries carry fieldStatus,
  // so parsed notes render exactly as before.
  const cameraClass = (entry: IntakeEntry, key: IntakeFieldKey, base = "") => {
    const status = entry.fieldStatus?.[key];
    const extra =
      status === "CONFLICT"
        ? " fs-conflict"
        : status === "SUGGESTED"
          ? " fs-verify"
          : status === "VERIFIED"
            ? " fs-verified"
            : "";
    return `${base}${extra}`.trim() || undefined;
  };
  const cameraNote = (entry: IntakeEntry, key: IntakeFieldKey) => {
    const status = entry.fieldStatus?.[key];
    if (status === "VERIFIED")
      return <span className="fs-badge ok">Đã xác khớp với kho</span>;
    if (status === "SUGGESTED")
      return <span className="fs-badge warn">Camera đoán — kiểm tra lại</span>;
    if (status === "CONFLICT")
      return (
        <span className="fs-badge danger">
          Mâu thuẫn — cần xác minh thủ công
        </span>
      );
    return null;
  };
  const blockingCount = clientErrorsByEntry.filter(
    (list) => list.length,
  ).length;
  const unknownCount = entries.reduce(
    (sum, entry) => sum + entry.unknownTokens.length,
    0,
  );
  const rules = listRules(dict);

  return (
    <div className="stack intake-page">
      <OperationRecoveryNotice<{ imported_count: number }>
        userId={profile?.id}
        operation="import_vehicles"
        scope="batch"
        onConfirmed={async () => {
          await client.invalidateQueries();
          navigate("/acquisitions");
        }}
      />
      <Link className="back-link" to="/acquisitions">
        <ArrowLeft size={16} /> Thu vào
      </Link>
      <PageHeader
        title="Thu xe tốc ký"
        description="Dán ghi chú để thu nhiều xe, mỗi dòng một xe. Muốn nhập từng xe, chọn Thu xe mới."
      />

      <Card className="intake-notes-card">
        <div className="intake-notes-heading">
          <h2 className="section-title">
            <NotebookPen size={16} aria-hidden="true" />
            <span>1. Dán ghi chú</span>
          </h2>
          <Button
            type="button"
            variant="secondary"
            onClick={() => void handlePasteClipboard()}
          >
            <ClipboardPaste size={16} /> Dán
          </Button>
        </div>

        <textarea
          ref={notesRef}
          className="intake-notes"
          rows={4}
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="tay ga den 29b1 123.45 21 gia 18tr5"
          aria-label="Ghi chú tốc ký danh sách xe cần thu"
        />
        <div className="row intake-notes-actions">
          <Button
            type="button"
            onClick={() => void handleParse()}
            disabled={!text.trim()}
          >
            Tách thành danh sách
          </Button>
          <span className="muted small">
            {entries.length
              ? `${entries.length} xe đã tách · ${unknownCount} từ chưa nhận diện`
              : "Càng sửa, lần sau tách càng đúng."}
          </span>
        </div>
        {entries.some((entry) => entry.sourceLine === "Camera thông minh") && (
          <div className="notice" role="status">
            Bản nháp từ Camera thông minh — kiểm tra các trường được đánh dấu
            trước khi thu xe. Ảnh camera sẽ đính vào xe sau khi lưu.
          </div>
        )}
        {dictionaryChanged && entries.length > 0 && (
          <div className="notice" role="status">
            Bộ nhớ viết tắt vừa được cập nhật.
            <Button
              type="button"
              variant="ghost"
              onClick={() => void handleParse()}
            >
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
          <Card
            key={entry.id}
            className={`intake-entry ${issues.length ? "has-issues" : ""}`}
          >
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
            {!!entry.photos?.length && (
              <div
                className="intake-camera-photos"
                aria-label="Ảnh camera kèm theo xe này"
              >
                {entry.photos.map((photo, index) => (
                  <span className="intake-camera-photo" key={photo.slice(-24)}>
                    <img src={photo} alt={`Ảnh camera ${index + 1}`} />
                    <button
                      type="button"
                      aria-label={`Bỏ ảnh camera ${index + 1}`}
                      onClick={() =>
                        setEntries((prev) =>
                          prev.map((row) =>
                            row.id === entry.id
                              ? {
                                  ...row,
                                  photos: row.photos?.filter(
                                    (_, i) => i !== index,
                                  ),
                                }
                              : row,
                          ),
                        )
                      }
                    >
                      ×
                    </button>
                  </span>
                ))}
                <small className="muted">
                  Ảnh sẽ được đính vào xe sau khi thu.
                </small>
              </div>
            )}
            <div className="form-grid intake-entry-grid">
              <Field
                label="Loại xe *"
                className={cameraClass(entry, "vehicle_type", "intake-span2")}
              >
                <AutocompleteInput
                  aria-label="Loại xe *"
                  value={entry.fields.vehicle_type ?? ""}
                  onChange={(value) =>
                    updateField(entry.id, "vehicle_type", value)
                  }
                  suggestions={suggestions("vehicle_type")}
                  maxSuggestions={10}
                  placeholder="VD: Honda Vision, Wave Alpha…"
                />
              </Field>
              <Field
                label="Số khung"
                className={cameraClass(entry, "frame_number")}
              >
                <input
                  value={entry.fields.frame_number ?? ""}
                  onChange={(event) =>
                    updateField(
                      entry.id,
                      "frame_number",
                      event.target.value.toUpperCase(),
                    )
                  }
                  autoCapitalize="characters"
                  placeholder="RLH160…"
                />
                {frameKindLabelOf(entry.fields.frame_number) && (
                  <span className="frame-kind-tag">
                    {frameKindLabelOf(entry.fields.frame_number)}
                  </span>
                )}
                {cameraNote(entry, "frame_number")}
              </Field>
              <Field
                label="Biển số"
                className={cameraClass(entry, "license_plate")}
              >
                <input
                  value={entry.fields.license_plate ?? ""}
                  onChange={(event) =>
                    updateField(
                      entry.id,
                      "license_plate",
                      event.target.value.toUpperCase(),
                    )
                  }
                  onBlur={(event) => {
                    if (event.target.value.trim()) {
                      updateField(
                        entry.id,
                        "license_plate",
                        canonicalizePlate(event.target.value),
                      );
                    }
                  }}
                  autoCapitalize="characters"
                  placeholder={PLATE_EXAMPLE}
                />
                {cameraNote(entry, "license_plate")}
              </Field>
              <Field
                label="Màu sắc"
                className={cameraClass(entry, "color")}
                labelAction={
                  <ColorSwatchAction
                    value={entry.fields.color ?? ""}
                    onPick={(word) => updateField(entry.id, "color", word)}
                  />
                }
              >
                <AutocompleteInput
                  aria-label="Màu sắc"
                  value={entry.fields.color ?? ""}
                  suggestions={suggestions("color")}
                  onChange={(value) => updateField(entry.id, "color", value)}
                  placeholder="Đen"
                />
                {cameraNote(entry, "color")}
              </Field>
              <Field
                label="Năm sản xuất"
                className={cameraClass(entry, "year")}
              >
                <input
                  value={entry.fields.year ?? ""}
                  onChange={(event) =>
                    updateField(entry.id, "year", event.target.value)
                  }
                  onBlur={(event) => {
                    const year = normalizeVehicleYear(
                      event.currentTarget.value,
                    );
                    if (year != null && String(year) !== entry.fields.year) {
                      updateField(entry.id, "year", String(year));
                    }
                  }}
                  inputMode="numeric"
                  placeholder="2022"
                />
                {cameraNote(entry, "year")}
              </Field>
              <Field label="Ngày thu">
                <input
                  value={dateDisplay(entry.fields.purchase_date ?? "")}
                  onChange={(event) =>
                    updateField(entry.id, "purchase_date", event.target.value)
                  }
                  onBlur={(event) => {
                    const iso = dateBlur(event.target.value);
                    if (iso !== entry.fields.purchase_date) {
                      updateField(entry.id, "purchase_date", iso);
                    }
                  }}
                  inputMode="numeric"
                  placeholder="dd/mm/yyyy"
                  autoCorrect="off"
                />
              </Field>
              <Field label="Giá thu">
                <IntakeMoneyInput
                  ariaLabel="Giá thu"
                  value={entry.fields.purchase_price ?? ""}
                  onChange={(value) =>
                    updateField(entry.id, "purchase_price", value)
                  }
                  placeholder="18tr5"
                />
                {entry.fields.purchase_price?.trim() ? null : (
                  <small className="muted">Bắt buộc khi thu xe.</small>
                )}
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
                onChange={(event) =>
                  updateField(entry.id, "notes", event.target.value)
                }
                placeholder="Tình trạng, giấy tờ, phụ kiện…"
              />
            </Field>

            {(entry.unknownTokens.length > 0 || hints.length > 0) && (
              <div className="intake-learn-strip">
                {entry.unknownTokens.map((token) => (
                  <span className="intake-token-chip" key={token}>
                    <code>{token}</code>
                    <button
                      type="button"
                      onClick={() => assignTokenToNotes(entry, token)}
                    >
                      + Ghi chú
                    </button>
                    <button
                      type="button"
                      className="teach"
                      onClick={() =>
                        openLesson({
                          key: token,
                          field: "vehicle_type",
                          value: "",
                        })
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
                    <Plus size={13} /> Học: “{token}” = “{entry.fields[field]}”?
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
                disabled={
                  !entry.fields.frame_number ||
                  !(entry.fields.vehicle_type ?? "").trim()
                }
                onClick={() =>
                  navigate("/acquisitions/new", {
                    state: {
                      aiDraft: entryToAcquisitionDraft(entry),
                    },
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
            <span className="muted small">
              {entries.length} xe trong danh sách
            </span>
          </div>
          {unknownCount > 0 && (
            <p className="muted small">
              Còn {unknownCount} từ chưa nhận diện — gán vào ghi chú hoặc dạy Cà
              Rem để lần sau tự hiểu.
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
            <p className="notice danger">{friendlyError(submit.error)}</p>
          )}
        </Card>
      )}

      <Card className="intake-dictionary">
        <details ref={dictionaryRef}>
          <summary>
            <GraduationCap size={15} aria-hidden="true" /> Bộ nhớ viết tắt của
            bạn ({rules.length})
          </summary>
          <p className="muted small">
            Cà Rem học riêng theo tài khoản của bạn và lưu trên thiết bị này.
            Mỗi lần bạn sửa hoặc dạy một từ viết tắt, lần dán sau sẽ tự đúng
            hơn.
          </p>
          {lesson && (
            <div className="intake-lesson-form">
              <Field label="Viết tắt">
                <input
                  value={lesson.key}
                  onChange={(event) =>
                    setLesson({ ...lesson, key: event.target.value })
                  }
                  autoFocus
                />
              </Field>
              <Field label="Trường điền">
                <select
                  value={lesson.field}
                  onChange={(event) => {
                    const field = event.target.value as IntakeFieldKey;
                    setLesson({
                      ...lesson,
                      field,
                      // Loại xe là tên tự do nên giữ nguyên giá trị đã gõ
                      // khi chuyển sang trường này (không bắt khớp danh mục).
                      value: lesson.value,
                    });
                  }}
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
                {lesson.field === "vehicle_type" ? (
                  <AutocompleteInput
                    aria-label="Thành"
                    value={lesson.value}
                    onChange={(value) => setLesson({ ...lesson, value })}
                    suggestions={typeNames}
                    maxSuggestions={10}
                    placeholder="VD: Honda Vision"
                  />
                ) : (
                  <input
                    value={lesson.value}
                    onChange={(event) =>
                      setLesson({ ...lesson, value: event.target.value })
                    }
                    placeholder="Ví dụ: Đen"
                  />
                )}
              </Field>
              <div className="row" style={{ gap: "8px" }}>
                <Button
                  type="button"
                  onClick={saveLesson}
                  disabled={!lesson.value.trim()}
                >
                  Lưu quy tắc
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setLesson(null)}
                >
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
                    {INTAKE_FIELDS.find((f) => f.key === rule.field)?.label ??
                      rule.field}
                  </small>
                  <button
                    type="button"
                    aria-label={`Quên quy tắc ${rule.key}`}
                    onClick={() =>
                      setDict(
                        forgetRule(profile?.id, rule.key, dictionaryStorage),
                      )
                    }
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

function IntakeMoneyInput({
  value,
  onChange,
  placeholder,
  ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  ariaLabel: string;
}) {
  return (
    <MoneyInput
      rawValue={value}
      onRawChange={onChange}
      parseInput={parseReviewedIntakeMoney}
      onChange={() => {}}
      placeholder={placeholder}
      aria-label={ariaLabel}
    />
  );
}
