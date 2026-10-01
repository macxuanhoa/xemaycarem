import {
  useState,
  useEffect,
  useRef,
  type ChangeEvent,
  type FocusEvent,
  type KeyboardEvent,
} from "react";
import {
  parseMoneyInput,
  formatVndNumber,
  formatVndWords,
  formatVndApproxText,
} from "@/lib/moneyHelper";

interface MoneyInputProps {
  value?: number;
  onChange: (value: number | undefined) => void;
  placeholder?: string;
  id?: string;
  name?: string;
  disabled?: boolean;
  required?: boolean;
  min?: number;
  max?: number;
  showShortcuts?: boolean;
  "aria-label"?: string;
  className?: string;
  autoFocus?: boolean;
  onBlur?: () => void;
}

export function MoneyInput({
  value,
  onChange,
  placeholder = "Ví dụ: 82.000.000",
  id,
  name,
  disabled,
  required,
  min,
  max,
  showShortcuts = true,
  "aria-label": ariaLabel,
  className = "",
  autoFocus,
  onBlur,
}: MoneyInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  // Text currently displayed in the input (always formatted with dots: e.g. 82.000.000)
  const [text, setText] = useState<string>(() =>
    value != null ? formatVndNumber(value) : "",
  );
  const [isFocused, setIsFocused] = useState<boolean>(false);

  // Sync internal text when external value changes and input is not focused
  useEffect(() => {
    if (!isFocused) {
      setText(value != null ? formatVndNumber(value) : "");
    }
  }, [value, isFocused]);

  const parsedNum = parseMoneyInput(text);

  const processInput = (
    raw: string,
    cursorBefore: number,
    inputEl: HTMLInputElement | null,
  ) => {
    // 1. If blank or whitespace:
    if (!raw || !raw.trim()) {
      setText("");
      onChange(undefined);
      return;
    }

    // 2. Reject negative numbers
    if (raw.includes("-")) {
      raw = raw.replace(/-/g, "");
    }

    // 3. Check for shorthand notation (e.g. "82tr", "82m", "150k", "1.2ty")
    if (/(?:tr|m|k|ty|tỷ|b)/i.test(raw)) {
      const parsedShorthand = parseMoneyInput(raw);
      if (parsedShorthand != null) {
        const formatted = formatVndNumber(parsedShorthand);
        setText(formatted);
        onChange(parsedShorthand);
        requestAnimationFrame(() => {
          if (inputEl) {
            inputEl.setSelectionRange(formatted.length, formatted.length);
          }
        });
        return;
      }
      // If user is currently typing shorthand (e.g. "82t"), preserve raw until complete
      setText(raw);
      return;
    }

    // 4. Count digits before cursor to compute new cursor position
    const digitsBeforeCursor = raw
      .slice(0, cursorBefore)
      .replace(/\D/g, "").length;

    // 5. Extract all digits
    const rawDigits = raw.replace(/\D/g, "");
    if (!rawDigits) {
      setText("");
      onChange(undefined);
      return;
    }

    // 6. Clean leading zeros: e.g. "05" -> "5", but keep single "0"
    const cleanDigits = rawDigits.replace(/^0+(?=\d)/, "");

    // 7. Max 13 digits (up to 1,000,000,000,000 VND / 1 trillion)
    const boundedDigits = cleanDigits.slice(0, 13);
    const num = Number(boundedDigits);

    if (!Number.isSafeInteger(num) || num > 1_000_000_000_000) {
      return;
    }

    // 8. Format with dots (Vietnamese thousand separator)
    const formatted = formatVndNumber(num);

    // 9. Compute new cursor position based on digits before cursor
    let newCursor = 0;
    let digitCount = 0;
    for (let i = 0; i < formatted.length; i++) {
      if (/\d/.test(formatted[i])) {
        digitCount++;
      }
      if (digitCount === digitsBeforeCursor) {
        newCursor = i + 1;
        break;
      }
    }
    if (digitCount < digitsBeforeCursor || newCursor === 0) {
      newCursor = formatted.length;
    }

    setText(formatted);
    onChange(num);

    requestAnimationFrame(() => {
      if (inputEl) {
        inputEl.setSelectionRange(newCursor, newCursor);
      }
    });
  };

  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    const input = e.target;
    const raw = input.value;
    const cursor = input.selectionStart ?? raw.length;
    processInput(raw, cursor, input);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Backspace") {
      const input = e.currentTarget;
      const { selectionStart, selectionEnd } = input;
      if (
        selectionStart != null &&
        selectionStart === selectionEnd &&
        selectionStart > 1 &&
        input.value[selectionStart - 1] === "."
      ) {
        e.preventDefault();
        const raw = input.value;
        const before = raw.slice(0, selectionStart - 2);
        const after = raw.slice(selectionStart);
        const nextRaw = before + after;
        processInput(nextRaw, selectionStart - 2, input);
      }
    }
  };

  const handleFocus = () => {
    setIsFocused(true);
  };

  const handleBlur = (e: FocusEvent<HTMLInputElement>) => {
    setIsFocused(false);
    const raw = e.target.value.trim();
    if (!raw) {
      setText("");
      onChange(undefined);
    } else {
      const num = parseMoneyInput(raw);
      if (num != null) {
        setText(formatVndNumber(num));
        onChange(num);
      } else {
        const digits = raw.replace(/\D/g, "");
        if (digits) {
          const parsed = Number(digits);
          if (Number.isSafeInteger(parsed) && parsed <= 1_000_000_000_000) {
            setText(formatVndNumber(parsed));
            onChange(parsed);
          } else {
            setText("");
            onChange(undefined);
          }
        } else {
          setText("");
          onChange(undefined);
        }
      }
    }
    onBlur?.();
  };

  const addShortcut = (amount: number) => {
    const current =
      value != null && Number.isFinite(value)
        ? value
        : (parseMoneyInput(text) || 0);
    const next = current + amount;
    const formatted = formatVndNumber(next);
    setText(formatted);
    onChange(next);
  };

  // Only ONE helper text below: preferred natural Vietnamese words
  const helperWords =
    parsedNum != null && parsedNum > 0
      ? formatVndWords(parsedNum) || formatVndApproxText(parsedNum)
      : "";

  return (
    <div className={`money-input-wrap ${className}`}>
      <div className="money-input-field">
        <input
          ref={inputRef}
          type="text"
          inputMode="numeric"
          id={id}
          name={name}
          disabled={disabled}
          required={required}
          autoFocus={autoFocus}
          min={min}
          max={max}
          aria-label={ariaLabel}
          placeholder={placeholder}
          value={text}
          aria-invalid={
            (!!text && parsedNum == null) ||
            (parsedNum != null &&
              ((min != null && parsedNum < min) ||
                (max != null && parsedNum > max)))
          }
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onFocus={handleFocus}
          onBlur={handleBlur}
          className="money-input"
          autoComplete="off"
        />
        <span className="money-currency-tag" title="Đơn vị: Việt Nam Đồng">
          ₫
        </span>
      </div>

      {helperWords && (
        <div className="money-helper-text" aria-live="polite">
          <span className="words-val">{helperWords}</span>
        </div>
      )}

      {showShortcuts && !disabled && (
        <div className="money-shortcuts" aria-label="Gợi ý số tiền nhanh">
          <button
            type="button"
            className="chip-btn"
            onClick={() => addShortcut(1_000_000)}
          >
            +1 triệu
          </button>
          <button
            type="button"
            className="chip-btn"
            onClick={() => addShortcut(5_000_000)}
          >
            +5 triệu
          </button>
          <button
            type="button"
            className="chip-btn"
            onClick={() => addShortcut(10_000_000)}
          >
            +10 triệu
          </button>
          <button
            type="button"
            className="chip-btn"
            onClick={() => addShortcut(50_000_000)}
          >
            +50 triệu
          </button>
          {parsedNum != null && parsedNum > 0 && (
            <button
              type="button"
              className="chip-btn chip-clear"
              onClick={() => {
                setText("");
                onChange(undefined);
              }}
            >
              Xóa
            </button>
          )}
        </div>
      )}
    </div>
  );
}

