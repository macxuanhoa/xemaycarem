import { type CSSProperties } from "react";
import "./carem-ride-loader.css";

/**
 * CaremRideLoader — prototype loading animation cinematic "Nam lái Honda SH".
 * Asset tách nền trong suốt từ ảnh tham chiếu thật (/carem-ride-subject.png).
 * Ba biến thể giảm dần độ phức tạp: fullscreen > section > compact.
 * Toàn bộ chuyển động chạy bằng CSS transform/opacity (compositor thread),
 * không vòng lặp JS — không ảnh hưởng thời gian hay tốc độ tải dữ liệu.
 */

export type CaremRideLoaderVariant = "fullscreen" | "section" | "compact";

/* Cấu hình tĩnh (không random để tránh re-render/flake test). */
const AMBIENT = [
  { top: "18%", delay: 0, dur: 4.6 },
  { top: "34%", delay: 1.4, dur: 5.8 },
  { top: "52%", delay: 0.7, dur: 4.2 },
  { top: "66%", delay: 2.2, dur: 6.4 },
  { top: "26%", delay: 3.1, dur: 5.1 },
];

const TRAIL = [
  { top: "16%", w: "52%", h: 2, a: 0.55, dur: 0.95, delay: 0 },
  { top: "28%", w: "68%", h: 3, a: 0.8, dur: 0.8, delay: 0.18 },
  { top: "43%", w: "44%", h: 2, a: 0.45, dur: 1.05, delay: 0.42 },
  { top: "56%", w: "72%", h: 3, a: 0.7, dur: 0.85, delay: 0.1 },
  { top: "70%", w: "58%", h: 2, a: 0.5, dur: 0.98, delay: 0.55 },
  { top: "82%", w: "40%", h: 2, a: 0.35, dur: 1.15, delay: 0.3 },
];

const DUST = [
  { x: "55%", y: "6%", s: 30, dur: 1.25, delay: 0 },
  { x: "70%", y: "2%", s: 22, dur: 1.45, delay: 0.35 },
  { x: "45%", y: "14%", s: 36, dur: 1.15, delay: 0.6 },
  { x: "65%", y: "8%", s: 18, dur: 1.6, delay: 0.2 },
  { x: "50%", y: "20%", s: 26, dur: 1.35, delay: 0.85 },
];

export function CaremRideLoader({
  variant = "fullscreen",
  label = "Cà Rem đang khởi động…",
}: {
  variant?: CaremRideLoaderVariant;
  label?: string;
}) {
  const heavy = variant === "fullscreen";
  const detailed = variant !== "compact";
  const trail = variant === "compact" ? TRAIL.slice(1, 4) : TRAIL;
  const drive = heavy ? "5.4s" : "4.2s";

  return (
    <div
      className={`crl crl-${variant}`}
      data-variant={variant}
      role="status"
      aria-live="polite"
      style={{ "--drive": drive } as CSSProperties}
    >
      <div className="crl-scene">
        {heavy && <div className="crl-sky" aria-hidden />}
        {heavy && (
          <div className="crl-ambient" aria-hidden>
            {AMBIENT.map((a) => (
              <i
                key={`${a.top}-${a.delay}`}
                style={
                  {
                    top: a.top,
                    "--delay": `${a.delay}s`,
                    "--dur": `${a.dur}s`,
                  } as CSSProperties
                }
              />
            ))}
          </div>
        )}
        <div className="crl-road" aria-hidden />
        <div className="crl-rider">
          <div className="crl-bob">
            <div className="crl-trail" aria-hidden>
              {trail.map((t) => (
                <i
                  key={`${t.top}-${t.delay}`}
                  style={
                    {
                      top: t.top,
                      "--w": t.w,
                      "--h": `${t.h}px`,
                      "--a": t.a,
                      "--dur": `${t.dur}s`,
                      "--delay": `${t.delay}s`,
                    } as CSSProperties
                  }
                />
              ))}
            </div>
            {detailed && (
              <div className="crl-dustfield" aria-hidden>
                {DUST.map((d) => (
                  <i
                    key={`${d.x}-${d.delay}`}
                    style={
                      {
                        "--x": d.x,
                        "--y": d.y,
                        "--s": `${d.s}px`,
                        "--dur": `${d.dur}s`,
                        "--delay": `${d.delay}s`,
                      } as CSSProperties
                    }
                  />
                ))}
              </div>
            )}
            <div className="crl-car">
              <img
                src="/carem-ride-subject.png"
                alt=""
                aria-hidden
                draggable={false}
                className="crl-subject"
              />
              {heavy && (
                <>
                  <span className="crl-spin crl-spin-front" aria-hidden />
                  <span className="crl-spin crl-spin-rear" aria-hidden />
                  <span className="crl-headlight" aria-hidden />
                  <span className="crl-lightcone" aria-hidden />
                </>
              )}
              {variant === "section" && (
                <>
                  <span className="crl-spin crl-spin-front" aria-hidden />
                  <span className="crl-headlight" aria-hidden />
                </>
              )}
              <span className="crl-shadow" aria-hidden />
            </div>
          </div>
        </div>
      </div>
      <div className="crl-meta">
        <span className="crl-wordmark">Cà Rem</span>
        <span className="crl-label">{label}</span>
        <span className="crl-progress" aria-hidden>
          <i />
        </span>
      </div>
    </div>
  );
}

export default CaremRideLoader;
