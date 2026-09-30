import { createClient } from "@supabase/supabase-js";
const url = import.meta.env.VITE_SUPABASE_URL?.trim();
const key = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim();
export const isConfigured = !!url && /^https?:\/\//.test(url) && !!key;
const safeLocal = () => (typeof localStorage !== "undefined" ? localStorage : null);
const safeSession = () => (typeof sessionStorage !== "undefined" ? sessionStorage : null);

const authStorage: Storage = {
  getItem: (key) => safeLocal()?.getItem(key) ?? safeSession()?.getItem(key) ?? null,
  setItem: (key, value) => {
    const persistent = safeLocal()?.getItem("xe-remember") !== "false";
    (persistent ? safeLocal() : safeSession())?.setItem(key, value);
    (persistent ? safeSession() : safeLocal())?.removeItem(key);
  },
  removeItem: (key) => {
    safeLocal()?.removeItem(key);
    safeSession()?.removeItem(key);
  },
  clear: () => {},
  key: () => null,
  length: 0,
};
export const supabase = isConfigured
  ? createClient(url, key, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        flowType: "pkce",
        storage: authStorage,
      },
    })
  : null;
