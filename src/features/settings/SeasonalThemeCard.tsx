import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CalendarDays, CheckCircle2, Sparkles } from "lucide-react";
import { Button, Card, ErrorState } from "@/components/ui";
import { api } from "@/lib/api";
import { AppError } from "@/lib/errors";
import { toast } from "@/lib/toast";
import {
  SEASONAL_THEME_QUERY_KEY,
  applySeasonalTheme,
  isSeasonalActive,
  setSeasonalPreview,
  useSeasonalTheme,
  type SeasonalMode,
  type SeasonalTheme,
} from "@/lib/seasonalTheme";

/**
 * OWNER-only control for the shared seasonal theme (Tết 2027).
 *
 * Two on/off switches decide the mode — "Áo Tết 2027" (bật ngay) and
 * "Tự động theo lịch" (kèm khoảng ngày) — plus one switch for the cinematic
 * opener. Nothing changes on anyone's screen until "Lưu giao diện": the value
 * is stored server-side and every open session picks it up through Supabase
 * Realtime. There is deliberately no local preview — a saved look IS the look
 * on every device, so the card can never show something the shop isn't running.
 */

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
        throw new AppError("Chế độ tự động cần cả ngày bắt đầu và kết thúc.");
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

  const replayOpening = () => {
    // Device-only replay; the shared configuration is never touched.
    setSeasonalPreview("on", true);
    applySeasonalTheme(
      client.getQueryData<SeasonalTheme>(SEASONAL_THEME_QUERY_KEY) ??
        FALLBACK_FOR_CARD,
    );
  };

  return (
    <Card className="stack">
      <div className="row between wrap gap-sm">
        <div>
          <h2 className="section-title">Giao diện hệ thống</h2>
          <p className="muted small">
            Không ảnh hưởng Sáng/Tối của từng người dùng.
          </p>
        </div>
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

      {pending ? (
        <p className="muted small">Đang tải…</p>
      ) : theme.isError && !theme.data ? (
        <ErrorState error={theme.error} />
      ) : (
        <>
          <div className="ac-switch-row">
            <label
              className={`ac-switch${mode === "AUTO" ? " is-disabled" : ""}`}
            >
              <input
                type="checkbox"
                disabled={mode === "AUTO"}
                checked={mode === "TET_2027"}
                onChange={(e) => {
                  setDirty(true);
                  setMode(e.target.checked ? "TET_2027" : "DEFAULT");
                }}
              />
              <span className="ac-switch-track" aria-hidden />
              <span className="ac-switch-text">
                <strong>Áo Tết 2027</strong>
                <small>Bật ngay cho toàn bộ cửa hàng.</small>
              </span>
            </label>
            <label className="ac-switch">
              <input
                type="checkbox"
                checked={mode === "AUTO"}
                onChange={(e) => {
                  setDirty(true);
                  setMode(e.target.checked ? "AUTO" : "DEFAULT");
                }}
              />
              <span className="ac-switch-track" aria-hidden />
              <span className="ac-switch-text">
                <strong>Tự động theo lịch</strong>
                <small>Bật/tắt áo Tết theo khoảng ngày.</small>
              </span>
            </label>
          </div>

          {mode === "AUTO" && (
            <div className="seasonal-window">
              <label className="seasonal-window-field">
                <span>Từ ngày</span>
                <input
                  type="date"
                  value={start}
                  onChange={(e) => {
                    setDirty(true);
                    setStart(e.target.value);
                  }}
                />
              </label>
              <span className="seasonal-window-arrow" aria-hidden>
                →
              </span>
              <label className="seasonal-window-field">
                <span>Đến ngày</span>
                <input
                  type="date"
                  value={end}
                  min={start || undefined}
                  onChange={(e) => {
                    setDirty(true);
                    setEnd(e.target.value);
                  }}
                />
              </label>
            </div>
          )}

          <div className="ac-switch-row">
            <label className="ac-switch">
              <input
                type="checkbox"
                checked={cinematic}
                onChange={(e) => {
                  setDirty(true);
                  setCinematic(e.target.checked);
                }}
              />
              <span className="ac-switch-track" aria-hidden />
              <span className="ac-switch-text">
                <strong>Màn chào Tết khi mở app</strong>
                <small>Chiếu một lần mỗi phiên mở app.</small>
              </span>
            </label>
          </div>

          {data?.cinematic_enabled && (
            <Button variant="ghost" onClick={replayOpening}>
              <Sparkles size={15} />
              <span>Xem lại màn chào Tết</span>
            </Button>
          )}

          {saveMutation.isError && (
            <ErrorState
              error={
                {
                  message: seasonalErrorText(saveMutation.error),
                } as Error
              }
            />
          )}

          {dirty && (
            <p className="muted small">
              Thay đổi chỉ hiện trên mọi máy sau khi lưu.
            </p>
          )}

          <div className="form-actions">
            <Button
              disabled={saveMutation.isPending || !dirty}
              onClick={() => saveMutation.mutate()}
            >
              {saveMutation.isPending ? "Đang lưu…" : "Lưu giao diện"}
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
