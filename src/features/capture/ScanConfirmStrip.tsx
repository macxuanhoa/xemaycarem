import { CircleAlert } from "lucide-react";
import { Button } from "@/components/ui";
import type { NearMatch } from "@/lib/smartcam/inventoryPrior";
import { nearMatchLabel } from "@/lib/smartcam/inventoryPrior";
import type { ScannedFields, ScannedKey } from "@/lib/smartcam/recognition";

const FIELD_LABELS: Record<ScannedKey, string> = {
  license_plate: "Biển số",
  frame_number: "Số khung",
};

export type ScanConfirmation = {
  fields: ScannedFields;
  /** Compact positions the camera could not resolve on its own. */
  disputed: Record<ScannedKey, number[]>;
  /** The reading the decoder ranked second, per field. */
  alternatives: Record<ScannedKey, string[]>;
  /** Records that differ from this read only at a disputed position. */
  near: NearMatch[];
};

type Props = {
  confirmation: ScanConfirmation;
  onAccept: () => void;
  onRescan: () => void;
  onUseInventory: (match: NearMatch) => void;
};

/** Characters of one field, with the unresolved ones boxed for the eye. */
function FieldValue({ value, disputed }: { value: string; disputed: number[] }) {
  // Warning positions count letters and digits only, exactly as the decoder
  // and the cloud OCR contract count them — separators never shift a mark.
  let position = 0;
  return (
    <dd>
      {[...value].map((character, index) => {
        const glyph = /[A-Z0-9]/i.test(character);
        const compactIndex = position;
        if (glyph) position++;
        return glyph && disputed.includes(compactIndex) ? (
          <mark
            className="smartcam-confirm-glyph"
            title="Ký tự camera chưa chắc"
            key={index}
          >
            {character}
          </mark>
        ) : (
          <span key={index}>{character}</span>
        );
      })}
    </dd>
  );
}

/**
 * The camera's "I am not certain" surface. It appears while the preview is
 * still live so the staff can simply re-shoot, and it asks about the exact
 * character that is in doubt instead of writing a guess into the CRM.
 */
export default function ScanConfirmStrip({
  confirmation,
  onAccept,
  onRescan,
  onUseInventory,
}: Props) {
  const entries = (Object.keys(FIELD_LABELS) as ScannedKey[]).filter(
    (key) => confirmation.fields[key],
  );
  return (
    <div className="smartcam-confirm" role="group" aria-label="Cần xác nhận kết quả quét">
      <p className="smartcam-confirm-head">
        <CircleAlert size={14} aria-hidden="true" />
        Camera chưa chắc chắn 100% — kiểm tra ký tự được đánh dấu
      </p>
      <dl className="smartcam-fields">
        {entries.map((key) => (
          <div key={key} className={"smartcam-field tone-warn" + (key === "frame_number" ? " wide" : "")}>
            <dt>{FIELD_LABELS[key]}</dt>
            <FieldValue
              value={confirmation.fields[key]}
              disputed={confirmation.disputed[key] ?? []}
            />
          </div>
        ))}
      </dl>
      {entries.map((key) =>
        (confirmation.alternatives[key] ?? []).length ? (
          <p className="smartcam-confirm-alt" key={`alt-${key}`}>
            Cách đọc khác: {confirmation.alternatives[key].slice(0, 2).join(" · ")}
          </p>
        ) : null,
      )}
      {confirmation.near.map((match) => (
        <div className="smartcam-confirm-stock" key={match.vehicle.id}>
          <span>{nearMatchLabel(match)}</span>
          <Button type="button" variant="secondary" onClick={() => onUseInventory(match)}>
            Đúng xe này
          </Button>
        </div>
      ))}
      <div className="smartcam-confirm-actions">
        <Button type="button" variant="primary" onClick={onAccept}>
          Đúng, dùng kết quả này
        </Button>
        <Button type="button" variant="ghost" onClick={onRescan}>
          Quét lại
        </Button>
      </div>
    </div>
  );
}
