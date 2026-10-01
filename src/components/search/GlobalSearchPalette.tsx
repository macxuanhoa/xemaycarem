import {
  useState,
  useEffect,
  useRef,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Bike, Clock3, Command, Search } from "lucide-react";
import { api } from "@/lib/api";
import { Badge, ErrorState } from "@/components/ui";
import { useAuth } from "@/features/auth/AuthProvider";
import { canManage, canOperate } from "@/lib/permissions";
import { useDebouncedValue } from "@/lib/useDebouncedValue";
import { getRecentVehicles, formatRelativeTime } from "@/lib/recentVehicles";
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
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const commands = [
    ...(canOperate(profile)
      ? [
          { label: "Thu xe", to: "/acquisitions/new" },
          { label: "Bán xe", to: "/sell" },
          { label: "Nhập CSV", to: "/import-vehicles" },
        ]
      : []),
    ...(canManage(profile)
      ? [{ label: "Chi phí", to: "/expenses" }]
      : []),
    { label: "Công nợ", to: "/receivables" },
    { label: "Khách hàng", to: "/customers" },
    { label: "Tồn kho", to: "/vehicles" },
    { label: "Quét QR", to: "/capture" },
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
        inputRef.current?.focus();
      }
      if (event.key === "Escape") setIsOpen(false);
    };
    const outside = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node))
        setIsOpen(false);
    };
    window.addEventListener("keydown", keydown);
    document.addEventListener("pointerdown", outside);
    return () => {
      window.removeEventListener("keydown", keydown);
      document.removeEventListener("pointerdown", outside);
    };
  }, []);
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
      inputRef.current?.focus();
      return;
    }
    if (!["ArrowDown", "ArrowUp"].includes(event.key)) return;
    event.preventDefault();
    const buttons = Array.from(
      containerRef.current?.querySelectorAll<HTMLButtonElement>(
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
  return (
    <div
      className="global-search-container"
      ref={containerRef}
      onKeyDown={keyboard}
    >
      <form className="global-search" onSubmit={submit}>
        <Search size={18} />
        <input
          ref={inputRef}
          aria-label="Tìm xe toàn hệ thống"
          aria-expanded={isOpen}
          aria-controls={isOpen ? "global-search-results" : undefined}
          type="search"
          enterKeyHint="search"
          placeholder="Số khung, biển số, mã xe… (Ctrl + K)"
          value={query}
          onFocus={() => setIsOpen(true)}
          onChange={(event) => {
            setQuery(event.target.value);
            setIsOpen(true);
          }}
          autoComplete="off"
        />
        <span className="search-palette-badge" aria-hidden="true">
          <Command size={12} /> K
        </span>
      </form>
      {isOpen && (
        <div
          id="global-search-results"
          className="search-palette-popover"
          aria-label="Kết quả tìm kiếm"
        >
          {matchingCommands.length > 0 && (
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
                    {command.label}
                    <ArrowRight size={16} />
                  </button>
                ))}
              </div>
            </div>
          )}
          {query.trim().length >= 2 ? (
            <div className="search-palette-section">
              <div className="search-palette-heading" role="status">
                {query.trim() !== debouncedQuery || search.isFetching ? (
                  <div className="row" style={{ gap: "8px", alignItems: "center" }}>
                    <div className="search-loading-spinner" style={{
                      width: "14px",
                      height: "14px",
                      border: "2px solid #e2e8f0",
                      borderTop: "2px solid var(--primary, #4f46e5)",
                      borderRadius: "50%",
                      animation: "spin 0.8s linear infinite"
                    }} />
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
                      {vehicle.brand} {vehicle.model}
                    </strong>
                    <small>
                      {vehicle.license_plate || vehicle.internal_code} · SK:{" "}
                      {vehicle.frame_number}
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
                    <strong>{customer.customer_name}</strong>
                    <small>
                      {customer.customer_phone} · {customer.purchases_count} xe
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
                      {sale.sale_code} · {sale.vehicle_name}
                    </strong>
                    <small>
                      {sale.customer_name} · {sale.license_plate}
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
        </div>
      )}
    </div>
  );
}
