import {
  useState,
  useRef,
  useEffect,
  useId,
  type InputHTMLAttributes,
  type KeyboardEvent,
} from "react";

interface AutocompleteInputProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "onChange"
> {
  value: string;
  onChange: (value: string) => void;
  suggestions: string[];
  maxSuggestions?: number;
}

export function AutocompleteInput({
  value,
  onChange,
  suggestions,
  maxSuggestions = 6,
  className = "",
  placeholder,
  onBlur,
  onFocus,
  onKeyDown,
  ...rest
}: AutocompleteInputProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const filtered = suggestions
    .filter((item) =>
      value ? item.toLowerCase().includes(value.toLowerCase()) : true,
    )
    .slice(0, maxSuggestions);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (!isOpen || filtered.length === 0) {
      if (e.key === "ArrowDown") {
        setIsOpen(true);
        setHighlightedIndex(0);
        e.preventDefault();
      }
      return;
    }

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightedIndex((prev) =>
        prev < filtered.length - 1 ? prev + 1 : 0,
      );
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightedIndex((prev) =>
        prev > 0 ? prev - 1 : filtered.length - 1,
      );
    } else if (e.key === "Enter" && highlightedIndex >= 0) {
      e.preventDefault();
      const selected = filtered[highlightedIndex];
      if (selected) {
        onChange(selected);
        setIsOpen(false);
      }
    } else if (e.key === "Escape") {
      setIsOpen(false);
    }
  };

  return (
    <div className="autocomplete-wrap" ref={containerRef}>
      <input
        type="text"
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setIsOpen(true);
          setHighlightedIndex(-1);
        }}
        onFocus={(event) => {
          // Only surface suggestions once the user has typed something. Just
          // focusing an empty field must not drop a recent-values list under it.
          if (value && filtered.length > 0) setIsOpen(true);
          onFocus?.(event);
        }}
        onBlur={(event) => {
          setIsOpen(false);
          setHighlightedIndex(-1);
          onBlur?.(event);
        }}
        onKeyDown={(event) => {
          handleKeyDown(event);
          if (!event.defaultPrevented) onKeyDown?.(event);
        }}
        className={`autocomplete-input ${className}`}
        placeholder={placeholder}
        autoComplete="off"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={isOpen && filtered.length > 0}
        aria-controls={listId}
        aria-activedescendant={
          highlightedIndex >= 0 && isOpen
            ? `${listId}-${highlightedIndex}`
            : undefined
        }
        {...rest}
      />
      {isOpen && filtered.length > 0 && (
        <ul id={listId} className="autocomplete-dropdown" role="listbox">
          {filtered.map((item, idx) => (
            <li
              key={item}
              id={`${listId}-${idx}`}
              role="option"
              aria-selected={idx === highlightedIndex}
              className={`autocomplete-item ${idx === highlightedIndex ? "highlighted" : ""}`}
              onPointerDown={(e) => {
                e.preventDefault(); // prevent blur before click
                onChange(item);
                setIsOpen(false);
              }}
            >
              {item}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
