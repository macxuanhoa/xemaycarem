import {
  useState,
  useRef,
  useEffect,
  type ChangeEvent,
  type FocusEvent,
  type KeyboardEvent,
} from "react";
import { Calendar, ChevronLeft, ChevronRight } from "lucide-react";
import {
  today,
  isoToDisplayDate,
  displayToIsoDate,
} from "@/lib/format";

export interface DatePickerProps {
  value?: string; // ISO format: YYYY-MM-DD
  onChange: (value: string) => void;
  onBlur?: () => void;
  max?: string; // ISO format: YYYY-MM-DD
  min?: string; // ISO format: YYYY-MM-DD
  disabled?: boolean;
  required?: boolean;
  id?: string;
  name?: string;
  placeholder?: string;
  "aria-label"?: string;
  className?: string;
  autoFocus?: boolean;
  align?: "left" | "right" | "auto";
}

export function DatePicker({
  value,
  onChange,
  onBlur,
  max,
  min,
  disabled = false,
  required = false,
  id,
  name,
  placeholder = "DD/MM/YYYY",
  "aria-label": ariaLabel = "Chọn ngày (ngày/tháng/năm)",
  className = "",
  autoFocus = false,
  align = "auto",
}: DatePickerProps) {
  // Visible text formatted as DD/MM/YYYY
  const [displayText, setDisplayText] = useState<string>(
    value ? isoToDisplayDate(value) : "",
  );
  const [isOpen, setIsOpen] = useState<boolean>(false);
  const [isFocused, setIsFocused] = useState<boolean>(false);
  const [isSelecting, setIsSelecting] = useState<boolean>(false);

  // Parse current active ISO date to determine calendar view month/year
  const activeIso = value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : today();
  const [activeYear, activeMonth] = activeIso.slice(0, 7).split("-").map(Number);

  const [viewYear, setViewYear] = useState<number>(activeYear);
  const [viewMonth, setViewMonth] = useState<number>(activeMonth - 1); // 0-indexed

  const [placement, setPlacement] = useState<"left" | "right">(() =>
    align === "right" ? "right" : "left",
  );
  const [popoverCoords, setPopoverCoords] = useState<{
    left?: number;
    top?: string;
    bottom?: string;
  }>({});

  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Keep placement in sync if align prop changes
  useEffect(() => {
    if (align === "right" || align === "left") {
      setPlacement(align);
    }
  }, [align]);

  // Adjust popover position and prevent bleeding off viewport edges
  useEffect(() => {
    if (!isOpen) return;

    const updatePosition = () => {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const popoverEl = popoverRef.current;
      const popoverWidth = popoverEl?.offsetWidth || 290;
      const popoverHeight = popoverEl?.offsetHeight || 320;
      const windowWidth =
        typeof window !== "undefined"
          ? window.innerWidth || document.documentElement.clientWidth
          : 1200;
      const windowHeight =
        typeof window !== "undefined"
          ? window.innerHeight || document.documentElement.clientHeight
          : 800;

      // 1. Determine preferred horizontal orientation
      let preferredAlign = align;
      if (preferredAlign === "auto") {
        const bleedRight = rect.left + popoverWidth > windowWidth - 12;
        const bleedLeft = rect.right - popoverWidth < 12;
        if (bleedRight && !bleedLeft) {
          preferredAlign = "right";
        } else {
          preferredAlign = "left";
        }
      }

      const isRight = preferredAlign === "right";
      setPlacement(isRight ? "right" : "left");

      // 2. Compute container-relative horizontal offset with viewport clamp
      const targetViewportLeft = isRight
        ? rect.right - popoverWidth
        : rect.left;
      const minViewportLeft = 12;
      const maxViewportLeft = Math.max(
        minViewportLeft,
        windowWidth - popoverWidth - 12,
      );
      const clampedViewportLeft = Math.min(
        Math.max(targetViewportLeft, minViewportLeft),
        maxViewportLeft,
      );
      const relativeLeft = Math.round(clampedViewportLeft - rect.left);

      // 3. Vertical flip if overflowing bottom of viewport
      const bleedBottom = rect.bottom + popoverHeight > windowHeight - 12;
      const hasRoomTop = rect.top - popoverHeight > 12;
      const placeTop = bleedBottom && hasRoomTop;

      setPopoverCoords({
        left: relativeLeft,
        top: placeTop ? "auto" : undefined,
        bottom: placeTop ? "calc(100% + 6px)" : undefined,
      });
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [isOpen, align]);

  // Sync internal display text when external value changes and input is not being typed in
  useEffect(() => {
    if (!isFocused) {
      setDisplayText(value ? isoToDisplayDate(value) : "");
    }
  }, [value, isFocused]);

  // Keep calendar view in sync when value changes externally
  useEffect(() => {
    if (value && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
      const [y, m] = value.slice(0, 7).split("-").map(Number);
      setViewYear(y);
      setViewMonth(m - 1);
    }
  }, [value]);

  // Close calendar popover when clicking outside
  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false);
      }
    };
    const handleKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") {
        setIsOpen(false);
        inputRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen]);

  const handleInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    setDisplayText(raw);
    const parsedIso = displayToIsoDate(raw);
    if (parsedIso) {
      onChange(parsedIso);
    } else if (!raw.trim()) {
      onChange("");
    }
  };

  const handleInputBlur = (e: FocusEvent<HTMLInputElement>) => {
    // Don't process blur if the user is clicking inside the calendar popover
    // This prevents the calendar from closing when selecting a date
    const relatedTarget = e.relatedTarget as HTMLElement;
    if (relatedTarget && popoverRef.current?.contains(relatedTarget)) {
      return;
    }

    // Don't process blur if currently selecting a date
    if (isSelecting) {
      return;
    }

    setIsFocused(false);
    const raw = e.target.value.trim();
    if (!raw) {
      setDisplayText("");
      onChange("");
      onBlur?.();
      return;
    }
    const parsedIso = displayToIsoDate(raw);
    if (parsedIso) {
      setDisplayText(isoToDisplayDate(parsedIso));
      onChange(parsedIso);
    } else {
      // Keep invalid raw text so user sees the mistake, but pass invalid to trigger validation error
      onChange("invalid-date");
    }
    onBlur?.();
  };

  const handleInputFocus = () => {
    setIsFocused(true);
  };

  const handleSelectDate = (year: number, monthIndex: number, day: number) => {
    setIsSelecting(true);
    const mStr = String(monthIndex + 1).padStart(2, "0");
    const dStr = String(day).padStart(2, "0");
    const iso = `${year}-${mStr}-${dStr}`;
    setDisplayText(`${dStr}/${mStr}/${year}`);
    onChange(iso);
    setIsOpen(false);
    setIsSelecting(false);
    inputRef.current?.focus();
  };

  const handlePrevMonth = () => {
    if (viewMonth === 0) {
      setViewYear((y) => y - 1);
      setViewMonth(11);
    } else {
      setViewMonth((m) => m - 1);
    }
  };

  const handleNextMonth = () => {
    if (viewMonth === 11) {
      setViewYear((y) => y + 1);
      setViewMonth(0);
    } else {
      setViewMonth((m) => m + 1);
    }
  };

  // Calendar math (without any UTC or timezone conversions)
  const daysInCurrentMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  // Day of week for 1st of month: Sunday=0, Monday=1, ... Saturday=6
  const firstDayOfWeek = new Date(viewYear, viewMonth, 1).getDay();
  // Vietnamese calendar starts on Monday (Monday = 0, Sunday = 6)
  const mondayOffset = (firstDayOfWeek + 6) % 7;

  const currentTodayIso = today();

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      setIsOpen(false);
    } else if (e.key === "ArrowDown" && !isOpen) {
      setIsOpen(true);
    }
  };

  return (
    <div
      ref={containerRef}
      className={`datepicker-container ${className}`}
      style={{ position: "relative", width: "100%" }}
    >
      <div className="datepicker-input-wrap">
        <input
          ref={inputRef}
          type="text"
          inputMode="numeric"
          id={id}
          name={name}
          disabled={disabled}
          required={required}
          autoFocus={autoFocus}
          placeholder={placeholder}
          aria-label={ariaLabel}
          value={displayText}
          onChange={handleInputChange}
          onFocus={handleInputFocus}
          onBlur={handleInputBlur}
          onKeyDown={handleKeyDown}
          onClick={() => !disabled && setIsOpen(true)}
          className="datepicker-input"
          autoComplete="off"
        />
        <button
          type="button"
          tabIndex={-1}
          disabled={disabled}
          className="datepicker-calendar-btn"
          onClick={(e) => {
            e.preventDefault();
            if (!disabled) {
              setIsOpen((prev) => !prev);
            }
          }}
          aria-label="Mở lịch chọn ngày"
          title="Mở lịch chọn ngày"
        >
          <Calendar size={18} />
        </button>
      </div>

      {isOpen && !disabled && (
        <div
          ref={popoverRef}
          className={`datepicker-popover ${placement === "right" ? "align-right" : ""} ${popoverCoords.bottom ? "placement-top" : ""}`}
          style={{
            ...(popoverCoords.left != null
              ? { left: `${popoverCoords.left}px`, right: "auto" }
              : {}),
            ...(popoverCoords.top ? { top: popoverCoords.top } : {}),
            ...(popoverCoords.bottom ? { bottom: popoverCoords.bottom } : {}),
          }}
          role="dialog"
          aria-label="Lịch chọn ngày"
          onMouseDown={(e) => {
            // Prevent input from losing focus when clicking inside the popover
            e.preventDefault();
          }}
        >
          {/* Header */}
          <div className="datepicker-header">
            <button
              type="button"
              className="datepicker-nav-btn"
              onClick={handlePrevMonth}
              aria-label="Tháng trước"
            >
              <ChevronLeft size={16} />
            </button>
            <span className="datepicker-month-label">
              Tháng {viewMonth + 1}, {viewYear}
            </span>
            <button
              type="button"
              className="datepicker-nav-btn"
              onClick={handleNextMonth}
              aria-label="Tháng sau"
            >
              <ChevronRight size={16} />
            </button>
          </div>

          {/* Weekday headers: Monday to Sunday */}
          <div className="datepicker-weekdays">
            <span>T2</span>
            <span>T3</span>
            <span>T4</span>
            <span>T5</span>
            <span>T6</span>
            <span>T7</span>
            <span>CN</span>
          </div>

          {/* Days Grid */}
          <div className="datepicker-days-grid">
            {/* Blank offset days */}
            {Array.from({ length: mondayOffset }).map((_, i) => (
              <span key={`blank-${i}`} className="datepicker-blank-cell" />
            ))}

            {/* Days of month */}
            {Array.from({ length: daysInCurrentMonth }).map((_, i) => {
              const day = i + 1;
              const mStr = String(viewMonth + 1).padStart(2, "0");
              const dStr = String(day).padStart(2, "0");
              const cellIso = `${viewYear}-${mStr}-${dStr}`;

              const isSelected = value === cellIso;
              const isToday = currentTodayIso === cellIso;
              const isDisabled =
                (max != null && cellIso > max) ||
                (min != null && cellIso < min);

              return (
                <button
                  key={day}
                  type="button"
                  disabled={isDisabled}
                  className={`datepicker-day-cell ${
                    isSelected ? "selected" : ""
                  } ${isToday ? "today" : ""}`}
                  onClick={() => handleSelectDate(viewYear, viewMonth, day)}
                >
                  {day}
                </button>
              );
            })}
          </div>

          {/* Quick Preset Buttons */}
          <div className="datepicker-footer">
            <button
              type="button"
              className="datepicker-quick-btn"
              onClick={(e) => {
                e.preventDefault();
                const nowIso = today();
                const [y, m, d] = nowIso.split("-").map(Number);
                handleSelectDate(y, m - 1, d);
              }}
            >
              Hôm nay
            </button>
            <button
              type="button"
              className="datepicker-quick-btn"
              onClick={(e) => {
                e.preventDefault();
                const now = new Date(today() + "T00:00:00Z");
                now.setUTCDate(now.getUTCDate() - 1);
                const yestIso = now.toISOString().slice(0, 10);
                const [y, m, d] = yestIso.split("-").map(Number);
                handleSelectDate(y, m - 1, d);
              }}
            >
              Hôm qua
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
