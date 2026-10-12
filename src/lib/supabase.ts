import { createClient } from "@supabase/supabase-js";
import { AppError } from "./errors";
import { networkFetch } from "./networkRequest";
const url = import.meta.env.VITE_SUPABASE_URL?.trim();
const key = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim();
export const isConfigured = !!url && /^https?:\/\//.test(url) && !!key;
function browserStorage(
  kind: "localStorage" | "sessionStorage",
): Storage | null {
  try {
    return globalThis[kind] ?? null;
  } catch {
    // Browsers may reject even access to the Storage getter.
    return null;
  }
}

function storageError() {
  return new AppError(
    "Trình duyệt không cho phép lưu phiên đăng nhập. Hãy cho phép lưu dữ liệu trang web hoặc giải phóng bộ nhớ rồi thử lại.",
  );
}

function readItem(storage: Storage | null, key: string) {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function setAuthRemember(remember: boolean) {
  try {
    const storage = browserStorage("localStorage");
    if (!storage) throw storageError();
    storage.setItem("xe-remember", String(remember));
  } catch {
    throw storageError();
  }
}

export const authStorage: Storage = {
  getItem: (key) =>
    readItem(browserStorage("localStorage"), key) ??
    readItem(browserStorage("sessionStorage"), key),
  setItem: (key, value) => {
    const local = browserStorage("localStorage");
    const session = browserStorage("sessionStorage");
    try {
      const persistent = local?.getItem("xe-remember") !== "false";
      const target = persistent ? local : session;
      if (!target) throw storageError();
      // Remove the old copy first: a failed write must not leave a newly
      // persisted session that the login UI reported as unsuccessful.
      globalThis[persistent ? "sessionStorage" : "localStorage"]?.removeItem(
        key,
      );
      target.setItem(key, value);
    } catch {
      throw storageError();
    }
  },
  removeItem: (key) => {
    let failed = false;
    for (const kind of ["localStorage", "sessionStorage"] as const) {
      try {
        globalThis[kind]?.removeItem(key);
      } catch {
        failed = true;
      }
    }
    if (failed) throw storageError();
  },
  clear: () => {},
  key: () => null,
  length: 0,
};
export const supabase = isConfigured
  ? createClient(url, key, {
      global: { fetch: networkFetch },
      db: { retry: false },
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        flowType: "pkce",
        storage: authStorage,
      },
    })
  : null;
