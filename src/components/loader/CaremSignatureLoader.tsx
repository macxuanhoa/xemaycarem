import { type CSSProperties } from "react";
import "./carem-signature-loader.css";

/**
 * CaremSignatureLoader — màn chờ bên trong ứng dụng (section/compact):
 * nét chữ kí "carem" tự viết ra kéo dài theo nhịp, và một chiếc xe mini
 * chạy ngang ngay phía trên nét chữ — nét chữ viết tới đâu xe lăn tới đó.
 * Vòng lặp "viết → nghỉ → tan nét → viết lại", không nền đen. Toàn bộ chạy
 * bằng CSS transform/opacity/stroke-dashoffset (compositor), không vòng lặp
 * JS — không ảnh hưởng thời gian hay tốc độ tải dữ liệu.
 */

/* Nét chữ kí viết tay "carem": một đường liền, mỗi chữ cái một nét mực,
   kết thúc bằng đà kéo về phía trước như chữ kí thật. */
const SIGNATURE_D =
  "M26 66 C10 74 8 40 26 38 C40 36 34 60 24 68 C34 74 46 70 52 60" +
  " C56 52 58 44 60 36 C62 46 64 58 66 64 C72 54 78 46 84 42" +
  " C80 58 84 66 94 64 C104 62 110 50 106 42 C100 34 94 44 94 54" +
  " C96 62 104 66 112 64 C118 62 122 56 124 48 C126 56 128 62 130 64" +
  " C134 52 142 42 150 42 C158 42 158 60 150 64 C144 66 140 60 142 52" +
  " C146 44 156 42 164 46 C172 50 176 58 182 62 C190 68 200 66 208 58" +
  " C214 52 218 46 222 40 C226 48 228 58 232 62 C240 70 254 68 268 58" +
  " C284 48 300 40 316 36";

export type CaremSignatureVariant = "section" | "compact";

export function CaremSignatureLoader({
  variant = "section",
  label = "Đang tải dữ liệu…",
}: {
  variant?: CaremSignatureVariant;
  label?: string;
}) {
  const cycle = variant === "section" ? "4.25s" : "3.6s";

  return (
    <div
      className={`csl csl-${variant}`}
      data-variant={variant}
      role="status"
      aria-live="polite"
      style={{ "--csl-cycle": cycle } as CSSProperties}
    >
      <div className="csl-scene">
        <svg
          className="csl-svg"
          viewBox="0 0 340 96"
          preserveAspectRatio="xMidYMid meet"
          aria-hidden
        >
          {/* Đường ray mờ — "tờ giấy" chờ nét mực */}
          <path className="csl-rail" d={SIGNATURE_D} />
          {/* Nét chữ kí tự viết */}
          <path className="csl-ink" d={SIGNATURE_D} pathLength={100} />
        </svg>
        {variant === "section" ? (
          // Xe mini lăn ngang phía trên nét chữ, cùng nhịp với nét mực.
          <span className="csl-bike" aria-hidden>
            <img
              src="/carem-ride-subject.png"
              alt=""
              aria-hidden
              draggable={false}
              className="csl-bike-img"
            />
          </span>
        ) : null}
      </div>
      <span className="csl-label">{label}</span>
    </div>
  );
}

export default CaremSignatureLoader;
