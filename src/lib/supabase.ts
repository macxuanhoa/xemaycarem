import { createClient } from "@supabase/supabase-js";
const url = import.meta.env.VITE_SUPABASE_URL?.trim();
const key = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim();
export const isConfigured = !!url && /^https?:\/\//.test(url) && !!key;
const authStorage: Storage = {
  getItem: (key) => localStorage.getItem(key) ?? sessionStorage.getItem(key),
  setItem: (key, value) => {
    const persistent = localStorage.getItem("xe-remember") !== "false";
    (persistent ? localStorage : sessionStorage).setItem(key, value);
    (persistent ? sessionStorage : localStorage).removeItem(key);
  },
  removeItem: (key) => {
    localStorage.removeItem(key);
    sessionStorage.removeItem(key);
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
