import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { canonicalizePlate } from "@/lib/plate";
import {
  compactFrame,
  frameKindFromCompact,
  type FrameInputKind,
} from "@/lib/frameNumber";
import { useDebouncedValue } from "@/lib/useDebouncedValue";
import type { VehicleStatus } from "@/types";

/** Một xe nghi trùng do server chiếu về (private.duplicate_result). */
export type DuplicateCandidate = {
  id: string;
  internal_code: string;
  license_plate: string;
  frame_number: string;
  frame_input_kind: FrameInputKind;
  status: VehicleStatus;
  vehicle_title?: string | null;
  vehicle_subtitle?: string | null;
};

export type DuplicateLevel = "GREEN" | "YELLOW" | "RED";

export type DuplicateCheckResult = {
  level: DuplicateLevel;
  reason: string;
  candidates: DuplicateCandidate[];
  candidate_ids: string[];
};

const GREEN_RESULT: DuplicateCheckResult = {
  level: "GREEN",
  reason: "",
  candidates: [],
  candidate_ids: [],
};

export type DuplicateCheckInput = {
  frameNumber: string;
  licensePlate: string;
  /** Bỏ trống để hook tự suy từ độ dài số khung đã nén. */
  frameInputKind?: FrameInputKind;
  excludeVehicleId?: string | null;
  enabled?: boolean;
  delay?: number;
};

/**
 * Chu kỳ kiểm tra nghi trùng cho form nhập/thu xe. Debounce cả số khung lẫn
 * biển số rồi gọi `check_vehicle_duplicates` — ĐÚNG bộ máy server sẽ chạy lại
 * khi lưu, nên không bao giờ "xanh lúc gõ, đỏ lúc bấm Lưu".
 *
 * `settled` cho biết người dùng đã ngừng gõ và kết quả hiện hành tương ứng với
 * những gì đang hiển thị; các form chỉ nên khóa nút Lưu theo mức khi `settled`.
 */
export function useVehicleDuplicateCheck(input: DuplicateCheckInput) {
  const frame = (input.frameNumber || "").trim().toUpperCase();
  const plate = canonicalizePlate(input.licensePlate || "");
  const kind: FrameInputKind =
    input.frameInputKind ?? frameKindFromCompact(compactFrame(frame));
  const delay = input.delay ?? 450;

  const debouncedFrame = useDebouncedValue(frame, delay);
  const debouncedPlate = useDebouncedValue(plate, delay);
  const settled = debouncedFrame === frame && debouncedPlate === plate;

  // Chỉ có tín hiệu để so khi người dùng gõ ít nhất biển hoặc số khung không rỗng.
  const hasSignal = compactFrame(debouncedFrame) !== "" || debouncedPlate !== "";
  const active = input.enabled !== false && settled && hasSignal;

  const query = useQuery({
    queryKey: [
      "vehicle-duplicate-check",
      debouncedFrame,
      debouncedPlate,
      kind,
      input.excludeVehicleId ?? null,
    ],
    queryFn: () =>
      api.checkVehicleDuplicates({
        frame_number: debouncedFrame,
        license_plate: debouncedPlate,
        frame_input_kind: kind,
        exclude_vehicle_id: input.excludeVehicleId ?? null,
      }),
    enabled: active,
    staleTime: 30_000,
  });

  const result: DuplicateCheckResult | undefined = active
    ? (query.data ?? undefined)
    : !hasSignal
      ? GREEN_RESULT
      : undefined;

  return {
    result,
    level: result?.level ?? "GREEN",
    kind,
    settled,
    isChecking: !settled || (active && query.isFetching),
    isError: active && query.isError,
    refetch: query.refetch,
    hasSignal,
  };
}
