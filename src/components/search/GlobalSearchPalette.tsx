import {
  useState,
  useEffect,
  useRef,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Bike, Clock3, Command, Search, X } from "lucide-react";
import { api } from "@/lib/api";
import { Badge, ErrorState } from "@/components/ui";
import { useAuth } from "@/features/auth/AuthProvider";
import { canManage, canOperate } from "@/lib/permissions";
import { useDebouncedValue } from "@/lib/useDebouncedValue";
import { useDialog } from "@/lib/useDialog";
import { getRecentVehicles, formatRelativeTime } from "@/lib/recentVehicles";
import { Highlight } from "@/components/search/Highlight";
import type { GlobalSearchResult } from "@/types";

const normalizeCommand = (value: string) =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .trim()
    .toLowerCase();

export function GlobalSearchPalette() {
  const { profile } = useAuth();
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebouncedValue(query.trim());
  const [isOpen, setIsOpen] = useState(false);
  const [mobile, setMobile] = useState(
    () =>
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(max-width: 768px)").matches,
  );
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const dialogRef = useDialog(isOpen && mobile, () => setIsOpen(false));
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(max-width: 768px)");
    const update = () => setMobile(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    if (!mobile || !isOpen) return;
    const viewport = window.visualViewport;
    const update = () => {
      dialogRef.current?.style.setProperty(
        "--search-viewport-top",
        `${viewport?.offsetTop ?? 0}px`,
      );
      dialogRef.current?.style.setProperty(
        "--search-viewport-height",
        `${viewport?.height ?? window.innerHeight}px`,
      );
    };
    update();
    viewport?.addEventListener("resize", update);
    viewport?.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    return () => {
      viewport?.removeEventListener("resize", update);
      viewport?.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [mobile, isOpen, dialogRef]);
  const commands = [
    ...(canOperate(profile)
      ? [
          { label: "Thu xe", to: "/acquisitions/new" },
          { label: "Thu xe tốc ký (dán ghi chú)", to: "/intake" },
          { label: "Bán xe", to: "/sell" },
        ]
      : []),
    ...(canManage(profile) ? [{ label: "Chi phí", to: "/expenses" }] : []),
    { label: "Công nợ", to: "/receivables" },
    { label: "Khách hàng", to: "/customers" },
    { label: "Tồn kho", to: "/vehicles" },
    { label: "Camera thông minh", to: "/capture" },
  ];
  const recentVehicles = isOpen ? getRecentVehicles(profile?.id) : [];
  useEffect(() => {
    const keydown = (event: globalThis.KeyboardEvent) => {
      const target = event.target as HTMLElement;
      const typing =
        target?.isContentEditable ||
        ["INPUT", "TEXTAREA", "SELECT"].includes(target?.tagName);
      if (
        ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") ||
        (event.key === "/" &&
          !typing &&
          !event.ctrlKey &&
          !event.metaKey &&
          !event.altKey)
      ) {
        event.preventDefault();
        setIsOpen(true);
        requestAnimationFrame(() =>
          inputRef.current?.focus({ preventScroll: true }),
        );
      }
      if (event.key === "Escape") setIsOpen(false);
    };
    const outside = (event: PointerEvent) => {
      if (
        !containerRef.current?.contains(event.target as Node) &&
        !dialogRef.current?.contains(event.target as Node)
      )
        setIsOpen(false);
    };
    window.addEventListener("keydown", keydown);
    document.addEventListener("pointerdown", outside);
    return () => {
      window.removeEventListener("keydown", keydown);
      document.removeEventListener("pointerdown", outside);
    };
  }, [dialogRef]);
  const search = useQuery({
    queryKey: ["global-search", profile?.id, debouncedQuery],
    queryFn: () =>
      api.call<GlobalSearchResult>("global_search", {
        p_query: debouncedQuery,
        p_limit: 6,
      }),
    enabled: isOpen && debouncedQuery.length >= 2,
    staleTime: 10000,
  });
  const results = query.trim() === debouncedQuery ? search.data : undefined;
  const open = (to: string) => {
    setIsOpen(false);
    setQuery("");
    navigate(to);
  };
  // The term actually used for the rendered results — same value on desktop
  // and mobile, so highlights land identically regardless of screen size.
  const term = debouncedQuery;
  const matchingCommands = commands.filter(
    (command) =>
      !query.trim() ||
      normalizeCommand(command.label).includes(normalizeCommand(query)),
  );
  const hasResults = !!(
    results?.vehicles.length ||
    results?.customers.length ||
    results?.sales.length
  );
  const keyboard = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      setIsOpen(false);
      if (!mobile) inputRef.current?.focus();
      return;
    }
    if (!["ArrowDown", "ArrowUp"].includes(event.key)) return;
    event.preventDefault();
    const buttons = Array.from(
      (mobile
        ? dialogRef.current
        : containerRef.current
      )?.querySelectorAll<HTMLButtonElement>(
        ".search-palette-popover button",
      ) ?? [],
    );
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "ArrowDown" ? index + 1 : index - 1;
    if (next < 0) inputRef.current?.focus();
    else buttons[Math.min(next, buttons.length - 1)]?.focus();
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const command = commands.find(
      (item) => normalizeCommand(item.label) === normalizeCommand(query),
    );
    if (command) return open(command.to);
    if (
      results?.vehicles.length === 1 &&
      !results.customers.length &&
      !results.sales.length
    )
      return open(`/vehicles/${results.vehicles[0].id}`);
    if (query.trim()) open(`/vehicles?q=${encodeURIComponent(query.trim())}`);
  };
  const searchInput = (
    <input
      ref={inputRef}
      data-dialog-initial-focus={mobile ? true : undefined}
      aria-label="Tìm xe toàn hệ thống"
      aria-controls={isOpen ? "global-search-results" : undefined}
      type="search"
      enterKeyHint="search"
      placeholder={
        mobile
          ? "Biển số, số khung, tên khách…"
          : "Số khung, biển số, mã xe… (Ctrl + K)"
      }
      value={query}
      onFocus={() => setIsOpen(true)}
      onChange={(event) => {
        setQuery(event.target.value);
        setIsOpen(true);
      }}
      autoComplete="off"
    />
  );
  const commandSection = matchingCommands.length > 0 && (
    <div className="search-palette-section">
      <div className="search-palette-heading">LỆNH NHANH</div>
      <div className="palette-commands">
        {matchingCommands.map((command) => (
          <button
            type="button"
            className="palette-cmd-btn"
            key={command.to}
            onClick={() => open(command.to)}
          >
            <Highlight text={command.label} query={term} />
            <ArrowRight size={16} />
          </button>
        ))}
      </div>
    </div>
  );
  const resultContent = (
    <>
      {query.trim().length < 2 || !hasResults ? commandSection : null}
      {query.trim().length >= 2 ? (
        <div className="search-palette-section">
          <div className="search-palette-heading" role="status">
            {query.trim() !== debouncedQuery || search.isFetching ? (
              <div className="row" style={{ gap: "8px", alignItems: "center" }}>
                <div
                  className="search-loading-spinner"
                  style={{
                    width: "14px",
                    height: "14px",
                    border: "2px solid #e2e8f0",
                    borderTop: "2px solid var(--primary, #4f46e5)",
                    borderRadius: "50%",
                    animation: "spin 0.8s linear infinite",
                  }}
                />
                <span>Đang tìm…</span>
              </div>
            ) : (
              "KẾT QUẢ TÌM KIẾM"
            )}
          </div>
          {search.error && (
            <ErrorState
              error={search.error}
              retry={() => void search.refetch()}
            />
          )}
          {results?.vehicles.map((vehicle) => (
            <button
              type="button"
              className="palette-result-item"
              key={vehicle.id}
              onClick={() => open(`/vehicles/${vehicle.id}`)}
            >
              <Bike size={20} />
              <span className="result-info">
                <strong>
                  <Highlight
                    text={`${vehicle.brand} ${vehicle.model}`}
                    query={term}
                  />
                </strong>
                <small>
                  <Highlight
                    text={vehicle.license_plate || vehicle.internal_code}
                    query={term}
                  />{" "}
                  · SK: <Highlight text={vehicle.frame_number} query={term} />
                </small>
              </span>
              <Badge status={vehicle.status} />
            </button>
          ))}
          {results?.customers.map((customer, index) => (
            <button
              type="button"
              className="palette-result-item"
              key={`${customer.customer_phone}-${index}`}
              onClick={() =>
                open(
                  `/customers?phone=${encodeURIComponent(customer.customer_phone)}`,
                )
              }
            >
              <span className="result-info">
                <strong>
                  <Highlight text={customer.customer_name} query={term} />
                </strong>
                <small>
                  <Highlight text={customer.customer_phone} query={term} /> ·{" "}
                  {customer.purchases_count} xe
                </small>
              </span>
              <ArrowRight size={16} />
            </button>
          ))}
          {results?.sales.map((sale) => (
            <button
              type="button"
              className="palette-result-item"
              key={sale.id}
              onClick={() => open(`/sales/${sale.id}`)}
            >
              <span className="result-info">
                <strong>
                  <Highlight text={sale.sale_code} query={term} /> ·{" "}
                  <Highlight text={sale.vehicle_name} query={term} />
                </strong>
                <small>
                  <Highlight text={sale.customer_name} query={term} /> ·{" "}
                  <Highlight text={sale.license_plate} query={term} />
                </small>
              </span>
              <Badge status={sale.status} />
            </button>
          ))}
          {results && !hasResults && !search.error && (
            <div className="palette-empty">
              <p>Không tìm thấy xe “{query}”. Thử số khung hoặc mã xe.</p>
              {canOperate(profile) && (
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => open("/acquisitions/new")}
                >
                  + Thu xe mới
                </button>
              )}
            </div>
          )}
        </div>
      ) : (
        recentVehicles.length > 0 && (
          <div className="search-palette-section">
            <div className="search-palette-heading">
              <Clock3 size={14} /> XE VỪA THAO TÁC
            </div>
            {recentVehicles.map((vehicle) => (
              <button
                type="button"
                key={vehicle.id}
                className="palette-result-item"
                onClick={() => open(`/vehicles/${vehicle.id}`)}
              >
                <span className="result-info">
                  <strong>
                    {vehicle.brand} {vehicle.model}
                  </strong>
                  <small>
                    {vehicle.license_plate || vehicle.internal_code} ·{" "}
                    {formatRelativeTime(vehicle.updated_at)}
                  </small>
                </span>
                <ArrowRight size={16} />
              </button>
            ))}
          </div>
        )
      )}
      {query.trim().length >= 2 && hasResults ? commandSection : null}
    </>
  );
  return (
    <div
      className="global-search-container"
      ref={containerRef}
      onKeyDown={keyboard}
    >
      {mobile ? (
        <button
          type="button"
          className="global-search search-mobile-trigger"
          aria-label="Tìm xe toàn hệ thống"
          aria-haspopup="dialog"
          aria-expanded={isOpen}
          onClick={() => setIsOpen(true)}
        >
          <Search size={18} aria-hidden="true" />
          <span>Tìm xe, khách hàng…</span>
        </button>
      ) : (
        <form
          className="global-search"
          role="search"
          aria-label="Tìm kiếm toàn hệ thống"
          onSubmit={submit}
        >
          <Search size={18} aria-hidden="true" />
          {searchInput}
          <span className="search-palette-badge" aria-hidden="true">
            <Command size={12} /> K
          </span>
        </form>
      )}
      {isOpen &&
        (mobile ? (
          createPortal(
            <div
              className="search-mobile-backdrop"
              role="presentation"
              onClick={() => setIsOpen(false)}
            >
              <div
                className="search-mobile-dialog"
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby="search-mobile-title"
                onClick={(event) => event.stopPropagation()}
              >
                <div className="search-mobile-header">
                  <h2 id="search-mobile-title">Tìm kiếm</h2>
                  <button
                    type="button"
                    className="icon-button search-mobile-close"
                    aria-label="Đóng tìm kiếm"
                    onClick={() => setIsOpen(false)}
                  >
                    <X size={20} />
                  </button>
                </div>
                <form
                  className="search-mobile-form global-search"
                  role="search"
                  aria-label="Tìm kiếm toàn hệ thống"
                  onSubmit={submit}
                >
                  <Search size={18} aria-hidden="true" />
                  {searchInput}
                </form>
                <div
                  id="global-search-results"
                  className="search-mobile-results search-palette-popover"
                  role="region"
                  aria-label="Kết quả tìm kiếm"
                >
                  {resultContent}
                </div>
              </div>
            </div>,
            document.body,
          )
        ) : (
          <div
            id="global-search-results"
            className="search-palette-popover"
            role="region"
            aria-label="Kết quả tìm kiếm"
          >
            {resultContent}
          </div>
        ))}
    </div>
  );
}
