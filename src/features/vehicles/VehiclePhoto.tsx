import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Camera } from "lucide-react";
import { api } from "@/lib/api";
import { Button, ErrorState } from "@/components/ui";
import type { VehicleImage } from "@/types";

export function VehiclePhoto({
  photo,
  vehicleName,
  removable,
}: {
  photo: VehicleImage;
  vehicleName: string;
  removable: boolean;
}) {
  const client = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const query = useQuery({
    queryKey: ["vehicle-image", photo.storage_path],
    queryFn: () => api.imageUrl(photo.storage_path),
    staleTime: 4 * 60 * 1000,
  });
  const remove = useMutation({
    mutationFn: () => api.call("remove_vehicle_image", { p_id: photo.id }),
    onSuccess: () => client.invalidateQueries(),
  });
  return (
    <div className="vehicle-photo">
      {query.data ? (
        <a href={query.data} target="_blank" rel="noreferrer">
          <img loading="lazy" src={query.data} alt={vehicleName} />
        </a>
      ) : (
        <div className="image-placeholder">
          <Camera size={28} />
          <span>{query.isError ? "Không tải được ảnh" : "Đang tải ảnh…"}</span>
        </div>
      )}
      {removable && (
        <div className="row">
          {confirm ? (
            <>
              <Button
                variant="danger"
                disabled={remove.isPending}
                onClick={() => remove.mutate()}
              >
                Gỡ ảnh
              </Button>
              <Button variant="ghost" onClick={() => setConfirm(false)}>
                Giữ lại
              </Button>
            </>
          ) : (
            <Button variant="ghost" onClick={() => setConfirm(true)}>
              Gỡ ảnh này
            </Button>
          )}
        </div>
      )}
      {remove.isError && <ErrorState error={remove.error} />}
    </div>
  );
}
