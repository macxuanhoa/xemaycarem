import { useRef, type ChangeEvent, type KeyboardEvent } from "react";
import { formatGroupedInteger } from "@/lib/vehicleInputFormatting";

interface GroupedIntegerInputProps {
  value?: number | string;
  onChange: (digits: string) => void;
  onBlur?: () => void;
  placeholder?: string;
  "aria-label"?: string;
}

/** Displays an integer with dot group separators while keeping raw digits in form state. */
export function GroupedIntegerInput({
  value,
  onChange,
  onBlur,
  placeholder,
  "aria-label": ariaLabel,
}: GroupedIntegerInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  const formatEdit = (raw: string, cursorBefore: number) => {
    const digitsBeforeCursor = raw.slice(0, cursorBefore).replace(/\D/g, "").length;
    const digits = raw.replace(/\D/g, "").replace(/^0+(?=\d)/, "");
    const formatted = formatGroupedInteger(digits);
    let nextCursor = 0;
    let count = 0;
    if (digitsBeforeCursor > 0) {
      nextCursor = formatted.length;
      for (let index = 0; index < formatted.length; index++) {
        if (/\d/.test(formatted[index])) count++;
        if (count === digitsBeforeCursor) {
          nextCursor = index + 1;
          break;
        }
      }
    }
    onChange(digits);
    requestAnimationFrame(() => {
      inputRef.current?.setSelectionRange(nextCursor, nextCursor);
    });
  };

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    formatEdit(
      event.currentTarget.value,
      event.currentTarget.selectionStart ?? event.currentTarget.value.length,
    );
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Backspace") return;
    const input = event.currentTarget;
    const { selectionStart, selectionEnd } = input;
    if (
      selectionStart != null &&
      selectionStart === selectionEnd &&
      selectionStart > 1 &&
      input.value[selectionStart - 1] === "."
    ) {
      event.preventDefault();
      formatEdit(
        input.value.slice(0, selectionStart - 2) + input.value.slice(selectionStart),
        selectionStart - 2,
      );
    }
  };

  return (
    <input
      ref={inputRef}
      type="text"
      inputMode="numeric"
      aria-label={ariaLabel}
      value={formatGroupedInteger(value)}
      onChange={handleChange}
      onKeyDown={handleKeyDown}
      onBlur={onBlur}
      placeholder={placeholder}
      autoComplete="off"
    />
  );
}
