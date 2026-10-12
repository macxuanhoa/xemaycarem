import { useEffect, useRef, useState } from "react";

/**
 * Đếm số "nhịp" LED khi một giá trị thống kê nhảy lên.
 *
 * Trả về một counter tăng thêm 1 mỗi lần `value` đổi (KHÔNG tính lần nhận dữ
 * liệu đầu tiên — `undefined` được coi là "chưa có số", nên load trang không
 * làm cả bảng nhấp nháy cùng lúc). Component render một span `.led-beat` với
 * `key={beat}` để CSS animation chạy đúng một vòng rồi tắt — không có ambient
 * loop, không tốn GPU khi đứng yên.
 */
export function useValueLedFlash<V>(value: V | undefined): number {
  const [beat, setBeat] = useState(0);
  const prev = useRef<V | undefined>(undefined);

  useEffect(() => {
    if (value === undefined) return;
    if (prev.current !== undefined && prev.current !== value) {
      setBeat((b) => b + 1);
    }
    prev.current = value;
  }, [value]);

  return beat;
}
