export type VietQrConfig = {
  bank_bin: string;
  bank_name: string;
  bank_account_no: string;
  bank_account_name: string;
  vietqr_enabled: boolean;
};

export type VietQrRequestStatus = "PENDING" | "CONFIRMED" | "CANCELLED";

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
