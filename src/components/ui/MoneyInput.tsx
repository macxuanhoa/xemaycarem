import { useState, useEffect, type ChangeEvent, type FocusEvent } from "react";
import {
  parseMoneyInput,
  formatVndNumber,
  formatVndDisplay,
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
  placeholder = "Ví dụ: 82tr hoặc 82.000.000",
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
  // text currently displayed in the input
  const [text, setText] = useState<string>(
    value != null ? formatVndNumber(value) : "",
  );
  const [isFocused, setIsFocused] = useState<boolean>(false);

  // Sync internal text when external value changes and input is not focused
  useEffect(() => {
    if (!isFocused) {
      setText(value != null ? formatVndNumber(value) : "");
    }
  }, [value, isFocused]);

  const parsed = parseMoneyInput(text);

  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    setText(raw);
    const num = parseMoneyInput(raw);
    onChange(num);
  };

  const handleBlur = (e: FocusEvent<HTMLInputElement>) => {
    setIsFocused(false);
    const num = parseMoneyInput(e.target.value);
    if (num != null) {
      setText(formatVndNumber(num));
      onChange(num);
    } else {
      onChange(undefined);
    }
    onBlur?.();
  };

  const handleFocus = () => {
    setIsFocused(true);
  };

  const addShortcut = (amount: number) => {
    const current = parsed || 0;
    const next = current + amount;
    setText(formatVndNumber(next));
    onChange(next);
  };

  return (
    <div className={`money-input-wrap ${className}`}>
      <div className="money-input-field">
        <input
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
            (!!text && parsed == null) ||
            (parsed != null &&
              ((min != null && parsed < min) || (max != null && parsed > max)))
          }
          onChange={handleChange}
          onFocus={handleFocus}
          onBlur={handleBlur}
          className="money-input"
        />
        {parsed != null && (
          <span className="money-currency-tag" title="Đơn vị Việt Nam Đồng">
            {formatVndDisplay(parsed)}
          </span>
        )}
      </div>

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
          {parsed != null && parsed > 0 && (
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
