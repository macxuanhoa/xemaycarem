/** Smart Sales Automation V1 + V2 — đối soát ngân hàng, liên hệ khách, kênh gửi. */

export type BankTxnProvider = "SEPAY" | "CASSO";

export type BankTxnStatus =
  | "UNMATCHED"
  | "MATCHED_PENDING"
  | "MANUAL_REVIEW"
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
  | "AUTO_MATCH_DISABLED";

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
  state: "NONE" | "MATCHED" | "REVIEW" | "RECORDED";
  bank_transaction_id?: string | null;
  sender_name?: string;
  transfer_at?: string | null;
};

export type WebhookHealth = { status: "CONFIGURED" | "NOT_CONFIGURED" };

export type AutomationSettings = {
  bank_provider?: BankTxnProvider | "";
  bank_webhook_enabled?: boolean;
  bank_auto_match_enabled?: boolean;
  thankyou_manual_enabled?: boolean;
};

export type CustomerContactChannel =
  | "ZALO_PERSONAL"
  | "MESSENGER_PERSONAL"
  | "ZALO_OA"
  | "FB_MESSENGER"
  | "SMS"
  | "OTHER";

export type CustomerContact = {
  id: string;
  sale_id: string;
  vehicle_id: string;
  phone: string;
  channel: CustomerContactChannel;
  handle: string;
  display_name: string;
  verified: boolean;
  note?: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  sale_code?: string;
};

export type ThankYouQueueItem = {
  id: string;
  event_type: "SALE_THANK_YOU" | "SALE_THANK_YOU_PERSONAL";
  channel: string;
  status:
    | "QUEUED"
    | "PROCESSING"
    | "SENT"
    | "DELIVERED"
    | "FAILED"
    | "SKIPPED"
    | "CANCELLED"
    | "AWAITING_STAFF";
  template_code: string;
  recipient_phone?: string;
  last_error_code?: string | null;
  created_at: string;
  processed_at?: string | null;
};

export type MessageTemplate = {
  code: string;
  name: string;
  channel: string;
  body: string;
  variables: string[];
  is_active: boolean;
  updated_at: string;
};

/** Liên kết deep-link chính thức cho kênh cá nhân (mở liên hệ, không bot). */
export function personalContactLink(
  channel: CustomerContactChannel,
  contact: { handle: string; phone: string },
): string | null {
  if (channel === "ZALO_PERSONAL") {
    if (/^0\d{9,10}$/.test(contact.phone)) return `https://zalo.me/${contact.phone.slice(1)}`;
    if (contact.handle) return `https://zalo.me/${encodeURIComponent(contact.handle)}`;
    return null;
  }
  if (channel === "MESSENGER_PERSONAL") {
    return contact.handle ? `https://m.me/${encodeURIComponent(contact.handle)}` : null;
  }
  return null;
}
