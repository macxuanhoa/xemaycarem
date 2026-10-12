// Chúc mừng bán xe – màn điện ảnh 10 giây: rồng vàng đế chế 3D giáng lâm,
// lượn xoắn, đáp xuống chữ CHÚC MỪNG, phun lửa về phía người xem rồi giữ
// tư thế chiến thắng giữa pháo hoa (src/lib/celebrate3d). Đây là lớp trình
// diễn thuần tuý: giao dịch đã được ghi nhận TRƯỚC khi hàm này chạy, mọi
// lỗi của hoạt hình đều rơi về bản pháo hoa 2D dự phòng (celebrate2d) hoặc
// im lặng – không bao giờ làm hỏng luồng bán hàng, không điều hướng hộ ai.
//
// Vòng đời: mount overlay → rAF loop tự kết thúc sau 10s → fade 600ms →
// dọn GPU. Bấm bất kỳ đâu = kết thúc sớm an toàn. Tôn trọng
// prefers-reduced-motion (khung tĩnh, không chuyển động). Tab ẩn = tạm
// dừng. Máy yếu = hạ nấc chất lượng, thấp nhất vẫn là rồng 3D đơn giản.

import { celebrateSale2D } from "./celebrate2d";

export type CelebrateOptions = {
  /** Dòng banner phụ trong banner chính, ví dụ biển số hoặc mã xe vừa bán. */
  detail?: string;
};

const LIFETIME_MS = 10000;

type StageModule = typeof import("./celebrate3d");

let stagePromise: Promise<StageModule> | null = null;

function loadStage(): Promise<StageModule> {
  if (!stagePromise) stagePromise = import("./celebrate3d");
  return stagePromise;
}

/**
 * Tải trước chunk 3D (three.js) lúc máy rảnh để khoảnh khắc chúc mừng không
 * phải chờ mạng. Không chặn luồng bán, không fail-đẹp: lỗi load âm thầm bỏ
 * qua, khi bán thật sẽ tự dùng bản 2D.
 */
export function preloadCelebration() {
  if (typeof window === "undefined" || stagePromise) return;
  const w = window as Window & { requestIdleCallback?: (cb: () => void) => number };
  const schedule = (cb: () => void) => {
    if (typeof w.requestIdleCallback === "function") w.requestIdleCallback(cb);
    else window.setTimeout(cb, 2500);
  };
  schedule(() => {
    loadStage().catch(() => {
      stagePromise = null;
    });
  });
}

/** Thăm dò WebGL2 – không có thì ở lại bản 2D, không thử vô ích. */
export function supportsStage3D(): boolean {
  try {
    const probe = document.createElement("canvas");
    return !!probe.getContext("webgl2");
  } catch {
    return false;
  }
}

export function celebrateSale(options: CelebrateOptions = {}) {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  // Không chồng hai màn chúc mừng cùng lúc.
  if (document.querySelector(".sale-celebrate")) return;

  const reduceMotion = window.matchMedia?.(
    "(prefers-reduced-motion: reduce)",
  ).matches;

  if (!supportsStage3D()) {
    celebrateSale2D(options);
    return;
  }

  const run = (mod: StageModule) => {
    let closed = false;
    let stage: ReturnType<StageModule["createStage"]> | null = null;
    const dismiss = () => {
      if (closed) return;
      closed = true;
      window.removeEventListener("pointerdown", dismiss);
      stage?.dismiss();
    };
    try {
      stage = mod.createStage({
        detail: options.detail,
        reducedMotion: reduceMotion,
        onExit: () => {
          closed = true;
          window.removeEventListener("pointerdown", dismiss);
        },
      });
      stage.start();
      // Chỉ khi chạy dev server: gắn tay nắm chẩn đoán để script kiểm thử
      // tua tới đúng giây của đòn múa mà chụp bằng chứng. Không lộ ra bản
      // build thật, không ảnh hưởng luồng bán hàng.
      if (import.meta.env.DEV) {
        (window as Window & { __dragon3d?: unknown }).__dragon3d = stage;
      }
      // Bấm vào màn hình là tắt sớm – không bắt nhân viên chờ xem rồng.
      window.addEventListener("pointerdown", dismiss, { once: true });
      // Dây an toàn cuối: nếu vòng lặp chết giữa chừng (tab bị kill), vẫn
      // gỡ listener để không rò rỉ, sau khi overlay tự fade xong.
      const safety = window.setTimeout(dismiss, LIFETIME_MS + 4000);
      if (import.meta.env.DEV) {
        // Script chụp bằng chứng dừng vòng lặp để tua từng giây; đồng hồ giờ
        // thật ở trên không được phép cắt ngang một khung đang được xem.
        stage?.debug.holdSafety(() => window.clearTimeout(safety));
      }
    } catch {
      if (!closed) {
        closed = true;
        window.removeEventListener("pointerdown", dismiss);
        try {
          stage?.dispose();
        } catch {
          /* GPU đã lỗi – bỏ qua, bản 2D sẽ gánh */
        }
        celebrateSale2D(options);
      }
    }
  };

  loadStage().then(run).catch(() => {
    stagePromise = null;
    celebrateSale2D(options);
  });
}
