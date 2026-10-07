import {
  useState,
  useEffect,
  useRef,
  useId,
  type ChangeEvent,
  type FocusEvent,
  type KeyboardEvent,
  type Ref,
  type AriaAttributes,
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
  /** Intake retains reviewed text using its established shorthand parser. */
  rawValue?: string;
  onRawChange?: (text: string) => void;
  parseInput?: (text: string) => number | undefined;
  placeholder?: string;
  id?: string;
  name?: string;
  ref?: Ref<HTMLInputElement>;
  disabled?: boolean;
  required?: boolean;
  min?: number;
  max?: number;
  "aria-label"?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: AriaAttributes["aria-invalid"];
  className?: string;
  autoFocus?: boolean;
  onBlur?: () => void;
}

export function MoneyInput({
  value,
  onChange,
  rawValue,
  onRawChange,
  parseInput = parseMoneyInput,
  placeholder = "Ví dụ: 82.000.000 hoặc 82tr5",
  id,
  name,
  ref,
  disabled,
  required,
  min,
  max,
  "aria-label": ariaLabel,
  "aria-describedby": describedBy,
  "aria-invalid": externalInvalid,
  className = "",
  autoFocus,
  onBlur,
}: MoneyInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const generatedId = useId();
  const inputId = id ?? `money-${generatedId}`;
  const helperId = `${inputId}-helper`;
  const errorId = `${inputId}-money-error`;
  const [text, setText] = useState(() => {
    if (rawValue === undefined)
      return value != null ? formatVndNumber(value) : "";
    const parsed = parseInput(rawValue);
    return parsed == null ? rawValue : formatVndNumber(parsed);
  });
  const notified = useRef<{ value: number | undefined; text: string } | null>(
    null,
  );

  useEffect(() => {
    if (rawValue !== undefined) {
      if (notified.current?.text === rawValue) return;
      notified.current = null;
      const parsed = parseInput(rawValue);
      setText(parsed == null ? rawValue : formatVndNumber(parsed));
    } else if (
      notified.current &&
      (Object.is(notified.current.value, value) ||
        (notified.current.value === undefined &&
          (value == null || Number.isNaN(value) || value === 0)))
    ) {
      // Parent validation must not erase the invalid text being corrected.
      notified.current = null;
    } else {
      setText(value != null ? formatVndNumber(value) : "");
    }
  }, [value, rawValue, parseInput]);

  const parsedNum = parseInput(text);
  const invalid =
    !!text.trim() &&
    (parsedNum == null ||
      (min != null && parsedNum < min) ||
      (max != null && parsedNum > max));
  const validationMessage =
    parsedNum != null && min != null && parsedNum < min
      ? `Số tiền phải từ ${formatVndNumber(min)} ₫.`
      : parsedNum != null && max != null && parsedNum > max
        ? `Số tiền không được vượt quá ${formatVndNumber(max)} ₫.`
        : "Nhập số tiền nguyên đồng không âm, tối đa 1.000.000.000.000 ₫. Ví dụ: 82.000.000 hoặc 82tr5.";
  useEffect(() => {
    // Optional form fields must also reject malformed, nonempty input.
    inputRef.current?.setCustomValidity(invalid ? validationMessage : "");
  }, [invalid, validationMessage]);
  const helperWords =
    parsedNum != null && !invalid
      ? formatVndWords(parsedNum) || formatVndApproxText(parsedNum)
      : "";
  // Shorthand such as 82tr5 stays editable while typing, so spell out the
  // exact grouped amount it already means before the field is committed.
  const canonicalText = parsedNum != null ? formatVndNumber(parsedNum) : "";
  const helperDigits =
    parsedNum != null && !invalid && text.trim() !== canonicalText
      ? `${canonicalText} ₫`
      : "";
  const notify = (nextText: string, number: number | undefined) => {
    notified.current = { value: number, text: nextText };
    setText(nextText);
    onRawChange?.(nextText);
    onChange(number);
  };

  const processInput = (
    raw: string,
    cursorBefore: number,
    input: HTMLInputElement,
    editingDigits = false,
  ) => {
    if (!raw.trim()) {
      notify("", undefined);
      return;
    }
    // Only actual digit edits to our own grouping may remove group separators.
    // Pasted/synthetic malformed input goes through the strict parser intact.
    const parsed = parseInput(editingDigits ? raw.replace(/\./g, "") : raw);
    if (parsed == null) {
      notify(raw, undefined);
      return;
    }
    const formatted = formatVndNumber(parsed);
    const digitsBefore = raw.slice(0, cursorBefore).replace(/\D/g, "").length;
    let cursor = formatted.length;
    if (cursorBefore === 0) cursor = 0;
    else if (!/[a-z₫đỷ]/i.test(raw)) {
      let digits = 0;
      for (let index = 0; index < formatted.length; index++) {
        if (/\d/.test(formatted[index])) digits++;
        if (digits === digitsBefore) {
          cursor = index + 1;
          break;
        }
      }
    }
    // Keep a completed unit editable so intake can append its valid suffix,
    // e.g. 18tr → 18tr5. Blur commits the canonical grouped display.
    notify(/[a-zỷ]/i.test(raw) ? raw : formatted, parsed);
    requestAnimationFrame(() => {
      if (document.activeElement === input)
        input.setSelectionRange(cursor, cursor);
    });
  };

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const native = event.nativeEvent as InputEvent;
    const isDigitEdit =
      native.inputType?.startsWith("delete") ||
      (native.inputType === "insertText" && /^\d+$/.test(native.data ?? ""));
    const editingGrouping =
      !!isDigitEdit &&
      parsedNum != null &&
      text === formatVndNumber(parsedNum) &&
      /^[\d.]+$/.test(input.value);
    processInput(
      input.value,
      input.selectionStart ?? input.value.length,
      input,
      editingGrouping,
    );
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (
      event.key !== "Backspace" ||
      parsedNum == null ||
      text !== formatVndNumber(parsedNum)
    )
      return;
    const input = event.currentTarget;
    const { selectionStart, selectionEnd } = input;
    if (
      selectionStart != null &&
      selectionStart === selectionEnd &&
      selectionStart > 1 &&
      input.value[selectionStart - 1] === "."
    ) {
      event.preventDefault();
      processInput(
        input.value.slice(0, selectionStart - 2) +
          input.value.slice(selectionStart),
        selectionStart - 2,
        input,
        true,
      );
    }
  };

  const handleBlur = (event: FocusEvent<HTMLInputElement>) => {
    const raw = event.currentTarget.value;
    const parsed = parseInput(raw);
    notify(parsed == null ? raw : formatVndNumber(parsed), parsed);
    onBlur?.();
  };
  const descriptionIds =
    [
      describedBy,
      helperWords ? helperId : undefined,
      invalid ? errorId : undefined,
    ]
      .filter(Boolean)
      .join(" ") || undefined;

  return (
    <div className={`money-input-wrap ${className}`}>
      <div className="money-input-field">
        <input
          ref={(input) => {
            inputRef.current = input;
            if (typeof ref === "function") ref(input);
            else if (ref) ref.current = input;
          }}
          type="text"
          inputMode="numeric"
          id={inputId}
          name={name}
          disabled={disabled}
          required={required}
          autoFocus={autoFocus}
          min={min}
          max={max}
          aria-label={ariaLabel}
          aria-describedby={descriptionIds}
          aria-invalid={invalid || externalInvalid || false}
          placeholder={placeholder}
          value={text}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onBlur={handleBlur}
          className="money-input"
          autoComplete="off"
        />
        <span className="money-currency-tag" aria-hidden="true">
          ₫
        </span>
      </div>
      {invalid ? (
        <p id={errorId} className="money-input-error field-error" role="alert">
          {validationMessage}
        </p>
      ) : helperWords || helperDigits ? (
        <div id={helperId} className="money-helper-text">
          {helperDigits ? (
            <span className="digits-val">{helperDigits}</span>
          ) : null}
          {helperWords ? (
            <span className="words-val">{helperWords}</span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
