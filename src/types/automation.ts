/** Đối soát ngân hàng — trạng thái giao dịch và khớp VietQR. */

export type BankTxnProvider = "SEPAY" | "CASSO";

export type BankTxnStatus =
  | "UNMATCHED"
  | "MATCHED_PENDING"
  | "MANUAL_REVIEW"
  | "RECEIVED"
  | "RECORDED"
  | "IGNORED";

export type BankTxnMatchReason =
  | ""
  | "REFERENCE_AMOUNT_MATCH"
  | "AMOUNT_MISMATCH"
  | "REQUEST_NOT_PENDING"
  | "REFERENCE_FOUND_NO_REQUEST"
  | "NO_REFERENCE"
  | "MANUAL_LINK"
  | "AUTO_MATCH_DISABLED"
  | "REQUEST_EXPIRED"
  | "TRANSFER_OUTSIDE_WINDOW"
  | "ACCOUNT_SNAPSHOT_MISMATCH"
  | "DUPLICATE_REQUEST_CREDIT"
  | "AMBIGUOUS_REFERENCE"
  | "RECORDING_REVIEW_REQUIRED";

export type BankTransaction = {
  id: string;
  provider: BankTxnProvider;
  provider_txn_id: string;
  amount: number;
  transfer_at: string;
  reference: string;
  transfer_content: string;
  sender_name: string;
  sender_bank: string;
  status: BankTxnStatus;
  match_reason: BankTxnMatchReason;
  qr_request_id: string | null;
  sale_id: string | null;
  vehicle_id: string | null;
  sale_code?: string | null;
  vehicle_label?: string | null;
  payment_id: string | null;
  confirmed_by: string | null;
  confirmed_at: string | null;
  received_at: string;
};

export type BankTransactionList = {
  items: BankTransaction[];
  total: number;
  pending_count: number;
};

/** Trạng thái đối soát của một yêu cầu VietQR (modal soi "tiền đã về chưa"). */
export type VietQrMatchingStatus = {
  state: "NONE" | "MATCHED" | "REVIEW" | "RECEIVED" | "RECORDED";
  qr_status?: import("./vietqr").VietQrRequestStatus;
  bank_received?: boolean;
  monitoring_available?: boolean;
  expires_at?: string;
  server_now?: string;
  payment_id?: string | null;
  bank_transaction_id?: string | null;
  sender_name?: string;
  transfer_at?: string | null;
};

export type WebhookHealth = { status: "CONFIGURED" | "NOT_CONFIGURED" };
