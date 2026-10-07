import { colorWordToHex, matchColorWord } from "@/lib/colorWords";

/**
 * Inline swatch rendered next to a "Màu sắc" field label. The native colour
 * picker is opened by a real tap on a transparent `<input type="color">` that
 * overlays the swatch — programmatic `.click()` on a hidden input is ignored
 * by mobile browsers, so the overlay keeps it working on touch devices too.
 * When the user picks a hue we snap it to the nearest Vietnamese word
 * (Đen/Trắng/Bạc/…) and push that word into the accompanying text input via
 * `onPick`. The swatch preview always reflects the current word so the field
 * reads as a set, not a raw hex string, keeping reports and print-outs
 * human-friendly.
 */
export function ColorSwatchAction({
  value,
  onPick,
  title = "Chọn màu từ bảng màu",
}: {
  value: string | undefined | null;
  onPick: (word: string) => void;
  title?: string;
}) {
  const hex = colorWordToHex(value);
  return (
    <span className="color-swatch-action">
      <span className="color-swatch-btn" style={{ backgroundColor: hex }} aria-hidden="true">
        <span className="color-swatch-dot" />
      </span>
      <input
        type="color"
        className="color-swatch-native"
        // Tap-first proxy for the native picker: keep it out of the tab order
        // and off the label linkage so the colour text field stays the primary
        // keyboard control.
        tabIndex={-1}
        aria-label={title}
        title={title}
        value={hex}
        onChange={(event) => onPick(matchColorWord(event.target.value))}
      />
    </span>
  );
}
