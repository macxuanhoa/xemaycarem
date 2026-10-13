import { type CSSProperties } from "react";
import "./carem-ride-loader.css";

/**
 * CaremRideLoader — màn chờ tối giản: đúng MỘT chiếc xe máy chạy ngang qua,
 * phía sau có làn khói ống xả bốc lên. Không còn nền trời, tia sáng môi
 * trường, bụi, vệt tốc độ, đèn pha, nón sáng, wordmark hay thanh tiến trình
 * — chỉ xe + khói, theo đúng yêu cầu. Toàn bộ chuyển động chạy bằng CSS
 * transform/opacity (compositor thread), không vòng lặp JS — không ảnh hưởng
 * thời gian hay tốc độ tải dữ liệu.
 */

export type CaremRideLoaderVariant = "fullscreen" | "section" | "compact";

/* Nhịp khói: các cụm bốc đều từ đuôi xe, so le thời gian để liền mạch.
   (Chỉ hai thông số — kích cỡ/bay do CSS quy định theo biến thể.) */
const SMOKE = [
  { delay: 0, dur: 1.5 },
  { delay: 0.35, dur: 1.7 },
  { delay: 0.7, dur: 1.4 },
  { delay: 1.05, dur: 1.8 },
  { delay: 1.35, dur: 1.5 },
];

export function CaremRideLoader({
  variant = "fullscreen",
  label = "Cà Rem đang khởi động…",
}: {
  variant?: CaremRideLoaderVariant;
  label?: string;
}) {
  const drive =
    variant === "fullscreen" ? "5.2s" : variant === "section" ? "4.4s" : "4s";

  return (
    <div
      className={`crl crl-${variant}`}
      data-variant={variant}
      role="status"
      aria-live="polite"
      style={{ "--drive": drive } as CSSProperties}
    >
      <div className="crl-scene">
        <div className="crl-rider">
          <div className="crl-bob">
            <div className="crl-smoke" aria-hidden>
              {SMOKE.map((s) => (
                <i
                  key={s.delay}
                  style={
                    {
                      "--sd": `${s.delay}s`,
                      "--sdur": `${s.dur}s`,
                    } as CSSProperties
                  }
                />
              ))}
            </div>
            <div className="crl-car">
              <img
                src="/carem-ride-subject.png"
                alt=""
                aria-hidden
                draggable={false}
                className="crl-subject"
              />
              <span className="crl-shadow" aria-hidden />
            </div>
          </div>
        </div>
      </div>
      <div className="crl-meta">
        <span className="crl-label">{label}</span>
      </div>
    </div>
  );
}

export default CaremRideLoader;
