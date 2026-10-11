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
    hint: "Giao diện thường ngày của cửa hàng.",
  },
  {
    value: "TET_2027",
    label: "Tết 2027 — bật ngay",
    hint: "Áo Tết cho tất cả tài khoản ngay sau khi lưu.",
  },
  {
    value: "AUTO",
    label: "Tự động theo lịch",
    hint: "Bật/tắt theo ngày bắt đầu và kết thúc bên dưới.",
  },
];

/** Server rejects are raised as fixed tokens; show the shop a sentence instead.
 *  Client-side guards already throw a Vietnamese AppError, which passes through. */
function seasonalErrorText(error: unknown): string {
  if (error instanceof AppError) return error.message;
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (message.includes("SEASONAL_WINDOW_REQUIRED"))
    return "Chế độ tự động cần cả ngày bắt đầu và ngày kết thúc.";
  if (message.includes("SEASONAL_WINDOW_REVERSED"))
    return "Ngày kết thúc phải từ ngày bắt đầu trở đi.";
  if (message.includes("SEASONAL_WINDOW_TOO_LONG"))
    return "Khoảng Tết tự động không được dài quá một năm.";
  if (message.includes("SEASONAL_MODE_INVALID"))
    return "Chế độ giao diện không hợp lệ.";
  if (message.includes("INVALID_DATE"))
    return "Ngày nhập chưa đúng định dạng.";
  if (message.includes("ACCESS_DENIED"))
    return "Chỉ OWNER mới được thay đổi giao diện toàn hệ thống.";
  return "Không lưu được cấu hình giao diện. Vui lòng thử lại.";
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
          "Chế độ tự động cần cả ngày bắt đầu và ngày kết thúc.",
        );
      }
      if (mode === "AUTO" && end < start) {
        throw new AppError("Ngày kết thúc phải từ ngày bắt đầu trở đi.");
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
      // The RPC echoes the resolved row; seeding the shared cache makes the OWNER's
      // own screen flip instantly while Realtime handles everyone else.
      client.setQueryData(SEASONAL_THEME_QUERY_KEY, fresh);
      setDirty(false);
      toast.success("Đã lưu giao diện hệ thống", {
        description:
          "Tất cả các phiên đang mở sẽ nhận thay đổi trong vài giây, không cần tải lại hay triển khai lại.",
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
          <h2 className="section-title">Giao diện hệ thống — Tết 2027</h2>
          <p className="muted">
            Cấu hình chung cho mọi tài khoản (OWNER, MANAGER, STAFF). Đây là lớp
            áo ngoài, không ảnh hưởng chế độ Sáng/Tối của từng người và không
            thay đổi bất kỳ nghiệp vụ nào.
          </p>
        </div>
        <div>
          {effectiveActive ? (
            <span
              className="badge badge-success"
              style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
            >
              <CheckCircle2 size={14} /> Đang bật áo Tết
            </span>
          ) : (
            <span
              className="badge badge-warning"
              style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
            >
              <CalendarDays size={14} /> Giao diện thường ngày
            </span>
          )}
        </div>
      </div>

      {pending ? (
        <p className="muted small">Đang tải cấu hình giao diện…</p>
      ) : theme.isError ? (
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
                  // The app's form reset gives every <input> width:100% and a 44px
                  // box, which is right for text fields but turns a radio into a
                  // full-width circle. Size this one back down here rather than in
                  // the shared stylesheet.
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
              <Field label="Ngày bắt đầu (âm lịch nên để vùng Tết)">
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
              padding: "16px",
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
              <span>Cho phép màn chào Tết điện ảnh khi mở ứng dụng</span>
            </label>
            <p
              className="muted"
              style={{ margin: "6px 0 0 28px", fontSize: "0.875rem" }}
            >
              <Sparkles size={13} style={{ marginRight: 4 }} />
              Chỉ chiếu khi mở ứng dụng (F5 hay chuyển trang không chiếu lại), bỏ
              qua nếu máy bật giảm chuyển động. Theme Tết thay đổi giữa phiên chỉ
              cập nhật giao diện, không cắt ngang màn hình. Không ảnh hưởng khi
              Theme Tết đang tắt.
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
              <span>Xem thử trên máy này</span>
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
                {preview === "on" ? "Đang xem thử" : "Áo Tết"}
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
                {preview === "off" ? "Đang khóa thường" : "Giao diện thường"}
              </Button>
            </div>
          </div>
          <p className="muted small">
            Xem thử chỉ áp dụng trên thiết bị này, trong phiên này — không gửi
            lên máy chủ, không ảnh hưởng tài khoản khác. Đóng tab là tự hủy.
          </p>

          {/* Requirement 8: the opening has its own switch and its own explicit
              replay. Previewing the áo Tết never summons the full-screen story —
              only this deliberate click does, on this device only. */}
          {theme.data?.cinematic_enabled && (
            <div className="row gap-sm wrap">
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
                <span>Xem lại màn chào Tết trên máy này</span>
              </Button>
              <span className="muted small">
                Chỉ chiếu cho riêng máy đang bấm; không đổi cấu hình, không gửi
                lên máy chủ.
              </span>
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
                : "Lưu giao diện cho toàn hệ thống"}
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
