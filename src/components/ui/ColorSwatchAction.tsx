import { useRef } from "react";
import { colorWordToHex, matchColorWord } from "@/lib/colorWords";

/**
 * Inline swatch button rendered next to a "Màu sắc" field label. Clicking the
 * swatch opens the browser's native colour picker; when the user picks a hue
 * we snap it to the nearest Vietnamese word (Đen/Trắng/Bạc/…) and push that
 * word into the accompanying text input via `onPick`. The swatch preview
 * always reflects the current word so the field reads as a set, not a raw
 * hex string, keeping reports and print-outs human-friendly.
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
  const ref = useRef<HTMLInputElement>(null);
  const hex = colorWordToHex(value);
  return (
    <span className="color-swatch-action">
      <button
        type="button"
        className="color-swatch-btn"
        style={{ backgroundColor: hex }}
        aria-label={title}
        title={title}
        onClick={(event) => {
          // Field is a <label> wrapping the text input — clicking this
          // button would otherwise focus that input instead. Stop the
          // bubbling so the colour picker opens cleanly.
          event.preventDefault();
          event.stopPropagation();
          ref.current?.click();
        }}
      >
        <span className="color-swatch-dot" aria-hidden="true" />
      </button>
      <input
        ref={ref}
        type="color"
        className="color-swatch-native"
        tabIndex={-1}
        aria-hidden="true"
        value={hex}
        onChange={(event) => onPick(matchColorWord(event.target.value))}
      />
    </span>
  );
}
