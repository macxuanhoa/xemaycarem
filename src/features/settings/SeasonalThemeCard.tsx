import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CalendarDays, CheckCircle2, Eye, Sparkles } from "lucide-react";
import { Button, Card, ErrorState, Field } from "@/components/ui";
import { api } from "@/lib/api";
import { AppError } from "@/lib/errors";
import { toast } from "@/lib/toast";
import {
  SEASONAL_THEME_QUERY_KEY,
  applySeasonalTheme,
  isSeasonalActive,
  seasonalPreview,
  setSeasonalPreview,
  useSeasonalTheme,
  type SeasonalMode,
  type SeasonalTheme,
} from "@/lib/seasonalTheme";

/**
 * OWNER-only control for the shared seasonal theme (Tết 2027).
 *
 * The whole program lives on this one card: pick a mode, optionally give AUTO a
 * window, flip the cinematic opener, save. The value is stored server-side, so
 * every MANAGER/STAFF session picks it up through Supabase Realtime — no rebuild,
 * no redeploy — and the Light/Dark choice of each user is never touched.
 */

const MODE_OPTIONS: { value: SeasonalMode; label: string; hint: string }[] = [
  {
    value: "DEFAULT",
    label: "Mặc định",
    hint: "Giao diện thường ngày.",
  },
  {
    value: "TET_2027",
    label: "Tết 2027 — bật ngay",
    hint: "Bật áo Tết ngay cho tất cả.",
  },
  {
    value: "AUTO",
    label: "Tự động theo lịch",
    hint: "Bật/tắt theo khoảng ngày bên dưới.",
  },
];

/** Server rejects are raised as fixed tokens; show the shop a sentence instead.
 *  Client-side guards already throw a Vietnamese AppError, which passes through. */
function seasonalErrorText(error: unknown): string {
  if (error instanceof AppError) return error.message;
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (message.includes("SEASONAL_WINDOW_REQUIRED"))
    return "Chế độ tự động cần cả ngày bắt đầu và kết thúc.";
  if (message.includes("SEASONAL_WINDOW_REVERSED"))
    return "Ngày kết thúc phải sau ngày bắt đầu.";
  if (message.includes("SEASONAL_WINDOW_TOO_LONG"))
    return "Khoảng Tết không được quá 1 năm.";
  if (message.includes("SEASONAL_MODE_INVALID"))
    return "Chế độ không hợp lệ.";
  if (message.includes("INVALID_DATE"))
    return "Ngày nhập sai định dạng.";
  if (message.includes("ACCESS_DENIED"))
    return "Chỉ OWNER mới được thay đổi.";
  return "Không lưu được. Vui lòng thử lại.";
}

export function SeasonalThemeCard() {
  const client = useQueryClient();
  const theme = useSeasonalTheme();
  const [mode, setMode] = useState<SeasonalMode>("DEFAULT");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [cinematic, setCinematic] = useState(false);
  const [dirty, setDirty] = useState(false);
  // Mirror of the device-only preview, so the toggle re-renders (sessionStorage
  // itself is not reactive).
  const [preview, setPreviewState] = useState<"on" | "off" | null>(
    seasonalPreview(),
  );

  useEffect(() => {
    if (!theme.data || dirty) return;
    setMode(theme.data.mode);
    setStart(theme.data.tet_start ?? "");
    setEnd(theme.data.tet_end ?? "");
    setCinematic(theme.data.cinematic_enabled);
  }, [theme.data, dirty]);

  const saveMutation = useMutation({
    mutationFn: () => {
      if (mode === "AUTO" && (!start || !end)) {
        throw new AppError(
          "Chế độ tự động cần cả ngày bắt đầu và kết thúc.",
        );
      }
      if (mode === "AUTO" && end < start) {
        throw new AppError("Ngày kết thúc phải sau ngày bắt đầu.");
      }
      return api.call<SeasonalTheme>("save_seasonal_theme", {
        p_data: {
          mode,
          tet_start: mode === "AUTO" ? start : null,
          tet_end: mode === "AUTO" ? end : null,
          cinematic_enabled: cinematic,
        },
      });
    },
    onSuccess: (fresh) => {
      client.setQueryData(SEASONAL_THEME_QUERY_KEY, fresh);
      setDirty(false);
      toast.success("Đã lưu giao diện", {
        description: "Mọi phiên đang mở sẽ tự cập nhật.",
      });
    },
  });

  const data = theme.data;
  const effectiveActive = isSeasonalActive(data ?? FALLBACK_FOR_CARD);
  const pending = theme.isPending;

  return (
    <Card className="stack">
      <div className="row between wrap gap-sm">
        <div>
          <h2 className="section-title">Giao diện hệ thống</h2>
          <p className="muted small">
            Áo ngoài chung — không ảnh hưởng Sáng/Tối hay nghiệp vụ.
          </p>
        </div>
        <div>
          {effectiveActive ? (
            <span
              className="badge badge-success"
              style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
            >
              <CheckCircle2 size={14} /> Áo Tết
            </span>
          ) : (
            <span
              className="badge badge-warning"
              style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
            >
              <CalendarDays size={14} /> Thường ngày
            </span>
          )}
        </div>
      </div>

      {pending ? (
        <p className="muted small">Đang tải…</p>
      ) : theme.isError && !theme.data ? (
        <ErrorState error={theme.error} />
      ) : (
        <>
          <div className="stack" style={{ gap: 10 }}>
            {MODE_OPTIONS.map((option) => (
              <label
                key={option.value}
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 10,
                  cursor: "pointer",
                }}
              >
                <input
                  type="radio"
                  name="seasonal-mode"
                  style={{
                    width: 18,
                    height: 18,
                    minHeight: 0,
                    padding: 0,
                    flexShrink: 0,
                    marginTop: 3,
                    accentColor: "var(--primary, #4f46e5)",
                  }}
                  checked={mode === option.value}
                  onChange={() => {
                    setDirty(true);
                    setMode(option.value);
                  }}
                />
                <span>
                  <strong>{option.label}</strong>
                  <br />
                  <span className="muted small">{option.hint}</span>
                </span>
              </label>
            ))}
          </div>

          {mode === "AUTO" && (
            <div className="form-grid">
              <Field label="Ngày bắt đầu">
                <input
                  type="date"
                  value={start}
                  onChange={(e) => {
                    setDirty(true);
                    setStart(e.target.value);
                  }}
                />
              </Field>
              <Field label="Ngày kết thúc">
                <input
                  type="date"
                  value={end}
                  onChange={(e) => {
                    setDirty(true);
                    setEnd(e.target.value);
                  }}
                />
              </Field>
            </div>
          )}

          <div
            style={{
              background: "var(--surface-sunken, #f8fafc)",
              padding: "14px 16px",
              borderRadius: 8,
              border: "1px solid var(--border-soft, #e2e8f0)",
            }}
          >
            <label
              style={{
                fontWeight: 600,
                display: "flex",
                alignItems: "center",
                gap: 10,
                cursor: "pointer",
              }}
            >
              <input
                type="checkbox"
                checked={cinematic}
                onChange={(e) => {
                  setDirty(true);
                  setCinematic(e.target.checked);
                }}
              />
              <span>Màn chào Tết khi mở app</span>
            </label>
            <p
              className="muted"
              style={{ margin: "4px 0 0 28px", fontSize: "0.8125rem" }}
            >
              <Sparkles size={13} style={{ marginRight: 4 }} />
              Chỉ chiếu lần đầu mở app, bỏ qua nếu giảm chuyển động.
            </p>
          </div>

          <div className="row between wrap gap-sm">
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                cursor: "pointer",
                fontWeight: 600,
              }}
            >
              <Eye size={16} />
              <span>Xem thử</span>
            </label>
            <div className="row gap-sm">
              <Button
                type="button"
                variant={preview === "on" ? "primary" : "secondary"}
                onClick={() => {
                  const next = preview === "on" ? null : ("on" as const);
                  setSeasonalPreview(next);
                  setPreviewState(next);
                  applySeasonalTheme(
                    client.getQueryData<SeasonalTheme>(SEASONAL_THEME_QUERY_KEY) ??
                      FALLBACK_FOR_CARD,
                  );
                }}
              >
                {preview === "on" ? "Đang xem Tết" : "Áo Tết"}
              </Button>
              <Button
                type="button"
                variant={preview === "off" ? "primary" : "secondary"}
                onClick={() => {
                  const next = preview === "off" ? null : ("off" as const);
                  setSeasonalPreview(next);
                  setPreviewState(next);
                  applySeasonalTheme(
                    client.getQueryData<SeasonalTheme>(SEASONAL_THEME_QUERY_KEY) ??
                      FALLBACK_FOR_CARD,
                  );
                }}
              >
                {preview === "off" ? "Đang khóa" : "Thường ngày"}
              </Button>
            </div>
          </div>
          <p className="muted small">
            Chỉ trên máy này, đóng tab tự hủy.
          </p>

          {/* Replay cinematic on this device only */}
          {theme.data?.cinematic_enabled && (
            <div className="row gap-sm wrap" style={{ alignItems: "center" }}>
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  setSeasonalPreview("on", true);
                  setPreviewState("on");
                  applySeasonalTheme(
                    client.getQueryData<SeasonalTheme>(SEASONAL_THEME_QUERY_KEY) ??
                      FALLBACK_FOR_CARD,
                  );
                }}
              >
                <Sparkles size={16} />
                <span>Xem lại màn chào Tết</span>
              </Button>
              <span className="muted small">Chỉ trên máy này.</span>
            </div>
          )}

          {saveMutation.isError && (
            <ErrorState error={{ message: seasonalErrorText(saveMutation.error) } as Error} />
          )}

          <div className="form-actions">
            <Button
              disabled={saveMutation.isPending || !dirty}
              onClick={() => saveMutation.mutate()}
            >
              {saveMutation.isPending
                ? "Đang lưu…"
                : "Lưu giao diện"}
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}

const FALLBACK_FOR_CARD: SeasonalTheme = {
  mode: "DEFAULT",
  tet_start: null,
  tet_end: null,
  cinematic_enabled: false,
  is_active: false,
};
