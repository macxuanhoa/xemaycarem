import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import type { Paged, Vehicle } from "@/types";

/**
 * "Xe yêu thích" — dấu sao cá nhân của từng tài khoản (khác với dữ liệu nghiệp
 * vụ: mỗi người giữ danh sách sao riêng, server nhân JWT của người đăng nhập
 * trong `toggle_vehicle_favorite`). Một lần bấm cập nhật tức thì cả danh sách
 * Kho lẫn hồ sơ xe đang mở; lỗi thì quay về dữ liệu thật bằng refetch.
 */
export const FAVORITE_COUNT_QUERY_KEY = ["favorite-vehicle-count"] as const;

function paintFavorite(
  client: ReturnType<typeof useQueryClient>,
  vehicleId: string,
  favorite: boolean,
) {
  client.setQueriesData<Paged<Vehicle>>(
    { queryKey: ["vehicles"] },
    (previous) =>
      previous
        ? {
            ...previous,
            items: previous.items.map((item) =>
              item.id === vehicleId
                ? { ...item, is_favorite: favorite }
                : item,
            ),
          }
        : previous,
  );
  client.setQueryData<Vehicle>(["vehicle", vehicleId], (previous) =>
    previous ? { ...previous, is_favorite: favorite } : previous,
  );
}

export function useToggleVehicleFavorite() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vehicleId: string) =>
      api.call<{ vehicle_id: string; favorite: boolean }>(
        "toggle_vehicle_favorite",
        { p_vehicle_id: vehicleId },
      ),
    onMutate: (vehicleId: string) => {
      // Xác định chiều bật/tắt từ dữ liệu thật đang hiển thị: ưu tiên hồ sơ xe
      // đang mở (tab chi tiết có thể được đến thẳng từ dashboard, danh sách
      // Kho không nằm trong cache), rồi mới quay về bản ghi trong danh sách.
      // Đọc non tay từ danh sách suông từng khiến cú "bỏ yêu thích" vẽ ngược
      // thành ngôi sao sáng khi xe không có mặt ở trang Kho nào đã cache.
      const detail = client.getQueryData<Vehicle>(["vehicle", vehicleId]);
      const inList = client
        .getQueriesData<Paged<Vehicle>>({ queryKey: ["vehicles"] })
        .flatMap(([, data]) => data?.items ?? [])
        .find((item) => item.id === vehicleId);
      const current = detail?.is_favorite ?? inList?.is_favorite ?? false;
      paintFavorite(client, vehicleId, !current);
    },
    onSuccess: (result) => {
      // server trả trạng thái chuẩn — vẽ lại để cache khớp tuyệt đối với DB
      paintFavorite(client, result.vehicle_id, result.favorite);
    },
    onError: (error, vehicleId) => {
      toast.error("Không lưu được yêu thích.", {
        description:
          error instanceof Error && error.message
            ? error.message
            : "Kiểm tra kết nối rồi thử lại.",
      });
      void client.invalidateQueries({ queryKey: ["vehicles"] });
      void client.invalidateQueries({ queryKey: ["vehicle", vehicleId] });
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey: FAVORITE_COUNT_QUERY_KEY });
      // Tab "Yêu thích" lọc phía server theo trang: bỏ sao thì xe phải rơi
      // khỏi danh sách, thêm sao thì xe phải xuất hiện — vẽ lạc quan một cờ
      // không đủ, cần một lượt đối chiếu lại tập dòng và tổng số.
      void client.invalidateQueries({ queryKey: ["vehicles"] });
    },
  });
}

/** Đếm xe yêu thích của chính mình — nuôi nhãn trên tab "Yêu thích" của Kho. */
export function useFavoriteVehicleCount(enabled = true) {
  return useQuery({
    queryKey: FAVORITE_COUNT_QUERY_KEY,
    queryFn: async () => {
      const page = await api.call<Paged<Vehicle>>("list_vehicles", {
        p_filters: { status: "ALL", favorite: "true", limit: 1 },
      });
      return page.total ?? 0;
    },
    staleTime: 60_000,
    enabled,
  });
}
