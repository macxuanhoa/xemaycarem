// Chúc mừng bán xe – Lễ hội pháo hoa rực rỡ phủ trực tiếp lên giao diện gốc.
// Tên lửa bắn vọt từ chân màn hình lên không trung với vận tốc cao,
// để lại vệt lửa sáng rực, nổ tung thành các cụm hoa đăng, liễu vàng và pháo nhẫn đa sắc.

import { celebrateSale2D } from "./celebrate2d";
export type { CelebrateOptions } from "./celebrate2d";

export function preloadCelebration() {
  // Giữ cho tính tương thích ngược
}

export function supportsStage3D(): boolean {
  return true;
}

export function celebrateSale(options: import("./celebrate2d").CelebrateOptions = {}) {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  // Không chồng hai màn chúc mừng cùng lúc.
  if (document.querySelector(".sale-celebrate")) return;

  // Sử dụng lễ hội pháo hoa phủ trực tiếp lên giao diện gốc
  celebrateSale2D(options);
}
