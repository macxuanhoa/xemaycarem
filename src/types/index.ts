export type Role = "OWNER" | "MANAGER" | "STAFF";
export type Profile = {
  id: string;
  full_name: string;
  username: string;
  role: Role;
  active: boolean;
  can_view_financials: boolean;
  must_change_password: boolean;
  disabled_until?: string | null;
  allowed_from?: string;
  allowed_until?: string;
  working_days?: readonly number[];
  deleted_at?: string | null;
  disable_reason?: string | null;
  created_at?: string;
  updated_at?: string;
};
export type Paged<T> = { items: T[]; total: number };
/** Persisted vehicle status — the only values ever stored in vehicles.status. */
export type VehicleStatus = "IN_STOCK" | "RESERVED" | "SOLD" | "CANCELLED";
/**
 * Query/filter aliases accepted by list_vehicles p_filters.status.
 * AVAILABLE and UNSOLD are NOT persisted statuses: the SQL expands them to
 * status IN ('IN_STOCK','RESERVED'). They must never leak into mutations.
 */
export type VehicleStatusFilter = VehicleStatus | "AVAILABLE" | "UNSOLD";
export type AcquisitionStatus = "COMPLETED" | "CANCELLED";
export type VehicleImage = {
  id: string;
  vehicle_id: string;
  storage_path: string;
  display_order: number;
};
export type Activity = {
  id: string;
  action: string;
  created_at: string;
  user_id?: string;
  full_name?: string;
  actor_name?: string;
  entity_type?: string;
  entity_id?: string;
  old_data?: Record<string, unknown>;
  new_data?: Record<string, unknown>;
};
export type Expense = {
  id: string;
  vehicle_id?: string;
  internal_code?: string;
  vehicle_name?: string;
  expense_type?: string;
  category?: string;
  description: string;
  amount: number;
  expense_date: string;
  status: "ACTIVE" | "CANCELLED";
  created_at?: string;
  created_by?: string;
};
/** Public showroom projection from list_showroom_vehicles — safe fields only. */
export type ShowroomVehicle = {
  id: string;
  brand: string;
  model: string;
  variant: string;
  year: number | null;
  color: string;
  license_plate: string;
  odometer: number | null;
  asking_price: number;
  purchase_date: string;
  created_at: string;
};
export type ShowroomLeadStatus = "NEW" | "CONTACTED" | "CLOSED" | "SPAM";
/** Showroom inquiry / buyback lead captured anonymously on /showroom. */
export type ShowroomLead = {
  id: string;
  kind: "BUYBACK" | "VEHICLE_INQUIRY";
  vehicle_id: string | null;
  vehicle_name: string | null;
  vehicle_year: string | null;
  customer_name: string;
  phone: string;
  expected_price: number | null;
  message: string | null;
  source: string;
  status: ShowroomLeadStatus;
  created_at: string;
};
export type Vehicle = {
  id: string;
  internal_code: string;
  license_plate: string;
  brand: string;
  model: string;
  variant: string;
  year: number | null;
  color: string;
  frame_number: string;
  engine_number: string;
  odometer: number;
  purchase_date: string;
  purchase_price?: number | null;
  expense_total?: number;
  total_cost?: number | null;
  asking_price: number;
  status: VehicleStatus;
  supplier_name: string;
  supplier_phone: string;
  notes: string;
  created_at: string;
  updated_at?: string;
  created_by?: string;
  cost_pending: boolean;
  days_in_inventory: number;
  images?: VehicleImage[];
  expenses?: Expense[];
  sales?: Sale[];
  activity?: Activity[];
};
export type IdentitySubject = "acquisition" | "sale";
// CCCD hồ sơ pháp lý. Sensitive: chỉ OWNER/MANAGER được cấp từ server.
export type IdentityDocument = {
  id: string;
  acquisition_id?: string | null;
  sale_id?: string | null;
  full_name: string;
  id_number: string;
  dob?: string | null;
  issued_date?: string | null;
  place_of_issue: string;
  address: string;
  front_image_path?: string | null;
  back_image_path?: string | null;
  updated_at?: string;
};
export type Acquisition = {
  id: string;
  vehicle_id: string;
  frame_number: string;
  license_plate?: string;
  brand: string;
  model: string;
  internal_code?: string;
  vehicle_name?: string;
  acquisition_date: string;
  purchase_price?: number | null;
  seller_name: string;
  seller_phone: string;
  status: AcquisitionStatus;
  notes: string;
  creator_name?: string;
  created_by: string;
  created_at: string;
};
export type Payment = {
  id: string;
  sale_id: string;
  amount: number;
  payment_method: "CASH" | "BANK_TRANSFER" | "OTHER";
  payment_date: string;
  reference: string;
  notes: string;
  status?: "ACTIVE" | "VOIDED";
  created_at?: string;
  creator_name?: string;
};
export type DebtStatus =
  "PAID" | "PARTIALLY_PAID" | "UNPAID" | "OVERDUE" | "CANCELLED";

export type Sale = {
  id: string;
  sale_code: string;
  vehicle_id: string;
  vehicle_name?: string;
  internal_code?: string;
  brand?: string;
  model?: string;
  license_plate?: string;
  frame_number?: string;
  customer_name: string;
  customer_phone: string;
  sale_price: number;
  sale_date: string;
  due_date?: string | null;
  debt_status?: DebtStatus;
  is_overdue?: boolean;
  sold_by: string;
  employee_name?: string;
  status: "COMPLETED" | "CANCELLED";
  notes: string;
  purchase_cost_snapshot?: number;
  expense_cost_snapshot?: number;
  total_cost_snapshot?: number;
  gross_profit?: number;
  paid_amount: number;
  remaining_amount: number;
  payments?: Payment[];
  vehicle?: Vehicle;
  created_at: string;
};
export type DateFilter = { from: string; to: string };

export type AnnouncementType = "INFO" | "SUCCESS" | "WARNING" | "CRITICAL";
export type AnnouncementDisplay = "STATIC" | "SCROLLING";
export type AnnouncementAudience = "ALL" | Role;
export type Announcement = {
  id: string;
  title: string | null;
  message: string;
  type: AnnouncementType;
  display_mode: AnnouncementDisplay;
  audience?: AnnouncementAudience;
  is_active?: boolean;
  starts_at: string | null;
  ends_at: string | null;
  dismissible: boolean;
  created_at?: string;
  updated_at?: string;
};
export type DashboardData = {
  in_stock: number;
  reserved: number;
  sold_today: number;
  sold_month: number;
  acquired_today: number;
  acquired_month: number;
  acquisitions_count: number;
  acquisition_cost: number | null;
  inventory_cost: number | null;
  inventory_cost_pending: number;
  // Server-computed from at-store stock (IN_STOCK + RESERVED) vs saved thresholds.
  inventory_indicator?: "LOW" | "NORMAL" | "HIGH";
  today_revenue: number | null;
  month_revenue: number | null;
  today_profit: number | null;
  month_profit: number | null;
  revenue: number | null;
  gross_profit: number | null;
  sales_count: number;
  business_expenses: number | null;
  unpaid_sales_count?: number;
  total_receivables?: number;
  overdue_sales_count?: number;
  total_overdue_debt?: number;
  old_inventory_count?: number;
  recent_sales: Sale[];
  recent_vehicles: Vehicle[];
  recent_acquisitions: Acquisition[];
  recent_expenses: Expense[];
  aging: { bucket: string; count: number }[];
  longest_stock: Vehicle[];
  top_profitable: Sale[] | null;
  daily_sales: { date: string; revenue: number; count: number }[];
};

export type ReceivablesSummary = {
  items: Sale[];
  total: number;
  total_receivable: number;
  total_overdue: number;
  overdue_count: number;
  unpaid_count: number;
};

export type DailyReconciliationPayment = Payment & {
  sale_code: string;
  customer_name: string;
  customer_phone: string;
  sale_date: string;
  sale_price: number;
  vehicle_name: string;
  internal_code: string;
  license_plate: string;
  is_prior_debt: boolean;
};

export type DailyReconciliation = {
  date: string;
  sales_count: number;
  sales_revenue: number;
  today_sales_collected: number;
  debt_collected_today: number;
  total_collected: number;
  cash_collected: number;
  bank_transfer_collected: number;
  other_collected: number;
  new_debt_created: number;
  business_expenses: number;
  vehicle_expenses: number;
  total_expenses: number;
  net_cash_movement: number;
  payments: DailyReconciliationPayment[];
  sales: Sale[];
  expenses: Expense[];
};

export type GlobalSearchResult = {
  vehicles: Array<{
    id: string;
    internal_code: string;
    brand: string;
    model: string;
    license_plate: string;
    frame_number: string;
    engine_number: string;
    asking_price: number;
    status: VehicleStatus;
  }>;
  customers: Array<{
    customer_name: string;
    customer_phone: string;
    purchases_count: number;
    total_spent: number;
    latest_sale_date: string;
  }>;
  sales: Array<{
    id: string;
    sale_code: string;
    customer_name: string;
    customer_phone: string;
    vehicle_name: string;
    internal_code: string;
    license_plate: string;
    sale_date: string;
    sale_price: number;
    remaining_amount: number;
    status: "COMPLETED" | "CANCELLED";
  }>;
};

export type CustomerSummary = {
  customer_name: string;
  customer_phone: string;
  purchases_count: number;
  total_spent: number;
  total_paid: number;
  total_debt: number;
  first_purchase_date: string;
  latest_purchase_date: string;
  sales?: Sale[];
  identity_warning?: boolean;
  customer_names?: string[];
};

/**
 * AI copilot. Every answer is a list of facts plus the exact evidence rows the
 * server read under this user's session, so each claim can be reopened.
 */
export type CopilotCitationType =
  | "vehicle"
  | "sale"
  | "expense"
  | "debt"
  | "metric"
  | "audit"
  | "profile"
  | "document"
  | "settings";

export type CopilotCitation = {
  id: string;
  type: CopilotCitationType;
  label: string;
  detail: string | null;
  route: string;
};

export type CopilotFact = {
  label: string;
  value: number | string;
  display: string;
  citation: string;
};

export type CopilotMode = "deterministic" | "llm";

export type CopilotAnswer = {
  kind: "copilot";
  mode: CopilotMode;
  available: boolean;
  coverage: "data" | "documents" | "both" | "none";
  period: string | null;
  facts: CopilotFact[];
  citations: CopilotCitation[];
  doc_excerpts: {
    id: string;
    title: string;
    section: string | null;
    excerpt: string;
  }[];
  answer_markdown: string;
  citation_ids?: string[];
  suggestions: { label: string; route: string }[];
  insufficient: boolean;
  warnings: string[];
};

export type KnowledgeAudience = "ALL" | "STAFF" | "MANAGER" | "OWNER";

/** One unanswered copilot question, aggregated by normalized text (OWNER reads these in /docs). */
export type CopilotGapItem = {
  id: string;
  question: string;
  hits: number;
  last_role: "OWNER" | "MANAGER" | "STAFF";
  asked_first_at: string;
  last_seen_at: string;
};

export type CopilotGapDigest = {
  items: CopilotGapItem[];
  total: number;
  days: number;
};

export type KnowledgeIndexItem = {
  slug: string;
  title: string;
  section: string | null;
  audience: KnowledgeAudience;
  source_path: string | null;
};

export type KnowledgeArticle = KnowledgeIndexItem & {
  body_md: string;
  updated_at: string;
};

export type KnowledgeSearchHit = KnowledgeIndexItem & {
  id: string;
  rank: number;
  excerpt: string;
};

/**
 * In-app business bell notice (migration 20261004003900). Titles and bodies are
 * rendered server-side in Vietnamese at write time, already money-gated per
 * recipient role — the client never recomputes them.
 */
export type NotificationAction =
  | "CREATE_ACQUISITION"
  | "CANCEL_ACQUISITION"
  | "CREATE_SALE"
  | "CANCEL_SALE"
  | "CREATE_PAYMENT"
  | "VOID_PAYMENT"
  | "CREATE_VEHICLE"
  | "UPDATE_VEHICLE";

export type NotificationItem = {
  id: string;
  action: NotificationAction;
  entity_type: string | null;
  entity_id: string | null;
  vehicle_id: string | null;
  title: string;
  body: string | null;
  deep_link: string | null;
  read_at: string | null;
  created_at: string;
  actor_id: string | null;
  actor_name: string | null;
};

export type NotificationList = {
  items: NotificationItem[];
  total: number;
  unread_count: number;
};

/** One time bucket ("Nãy", "Hôm nay"…) inside the bell panel. */
export type NotificationGroup = {
  label: string;
  items: NotificationItem[];
};
