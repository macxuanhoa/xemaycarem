export type VietQrConfig = {
  bank_bin: string;
  bank_name: string;
  bank_account_no: string;
  bank_account_name: string;
  vietqr_enabled: boolean;
};

export type VietQrRequestStatus =
  "PENDING" | "RECEIVED" | "CONFIRMED" | "EXPIRED" | "CANCELLED";

export type VietQrPaymentRequest = {
  id: string;
  qr_reference: string;
  vehicle_id: string;
  sale_id: string | null;
  amount: number;
  bank_bin: string;
  bank_name: string;
  bank_account_no: string;
  bank_account_name: string;
  qr_payload: string;
  /** Server snapshots; closing/reopening never extends these timestamps. */
  expires_at: string;
  replace_available_at: string;
  server_now: string;
  monitoring_available: boolean;
  transfer_content: string;
  agreement_text: string;
  payer_name: string;
  contract_reference: string;
  vehicle_label: string;
  bank_transaction_id: string | null;
  receipt_id: string | null;
  status: VietQrRequestStatus;
  payment_id: string | null;
  superseded?: boolean;
  created_by: string;
  confirmed_by?: string | null;
  confirmed_at?: string | null;
  cancelled_by?: string | null;
  cancelled_at?: string | null;
  cancellation_reason?: string | null;
  created_at: string;
  updated_at: string;
};
