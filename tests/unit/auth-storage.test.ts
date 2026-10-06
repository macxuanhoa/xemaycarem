import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@supabase/supabase-js", () => ({ createClient: vi.fn() }));
import { authStorage, setAuthRemember } from "@/lib/supabase";
import { AppError } from "@/lib/errors";

const descriptors = {
  localStorage: Object.getOwnPropertyDescriptor(globalThis, "localStorage"),
  sessionStorage: Object.getOwnPropertyDescriptor(globalThis, "sessionStorage"),
};
function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
    clear: () => values.clear(),
  };
}
function installStorage(local = memoryStorage(), session = memoryStorage()) {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: local,
  });
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: session,
  });
  return { local, session };
}
afterEach(() => {
  for (const name of ["localStorage", "sessionStorage"] as const) {
    const descriptor = descriptors[name];
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

describe("Auth storage failure recovery", () => {
  it("blocked Storage getters read as no accessible session and writes fail closed", () => {
    for (const name of ["localStorage", "sessionStorage"] as const)
      Object.defineProperty(globalThis, name, {
        configurable: true,
        get() {
          throw new Error("Blocked");
        },
      });
    expect(authStorage.getItem("synthetic-token")).toBeNull();
    expect(() =>
      authStorage.setItem("synthetic-token", "synthetic-value"),
    ).toThrow(AppError);
    expect(() => setAuthRemember(true)).toThrow(/lưu phiên đăng nhập/);
  });

  it("a rejected persistent read can still resolve a valid tab session", () => {
    const { local, session } = installStorage();
    session.setItem("synthetic-token", "tab-session");
    vi.spyOn(local, "getItem").mockImplementation(() => {
      throw new Error("Blocked read");
    });
    expect(authStorage.getItem("synthetic-token")).toBe("tab-session");
  });

  it("remembered sessions use persistent storage and remove the tab copy", () => {
    const { local, session } = installStorage();
    session.setItem("synthetic-token", "old");
    setAuthRemember(true);
    authStorage.setItem("synthetic-token", "remembered");
    expect(local.getItem("synthetic-token")).toBe("remembered");
    expect(session.getItem("synthetic-token")).toBeNull();
  });

  it("opting out never persists the new session in localStorage", () => {
    const { local, session } = installStorage();
    local.setItem("synthetic-token", "old");
    setAuthRemember(false);
    authStorage.setItem("synthetic-token", "tab-only");
    expect(local.getItem("synthetic-token")).toBeNull();
    expect(session.getItem("synthetic-token")).toBe("tab-only");
  });

  it("quota failures propagate a clear error instead of claiming persistence", () => {
    const { local } = installStorage();
    vi.spyOn(local, "setItem").mockImplementation(() => {
      throw new Error("Quota exceeded");
    });
    expect(() => authStorage.setItem("synthetic-token", "new")).toThrow(
      /lưu phiên đăng nhập/,
    );
    expect(local.getItem("synthetic-token")).toBeNull();
  });

  it("an unreadable remember preference cannot silently change its privacy setting", () => {
    const { local, session } = installStorage();
    vi.spyOn(local, "getItem").mockImplementation(() => {
      throw new Error("Blocked read");
    });
    const localWrite = vi.spyOn(local, "setItem");
    const sessionWrite = vi.spyOn(session, "setItem");
    expect(() => authStorage.setItem("synthetic-token", "new")).toThrow(
      AppError,
    );
    expect(localWrite).not.toHaveBeenCalled();
    expect(sessionWrite).not.toHaveBeenCalled();
  });

  it("logout attempts both removals and reports an incomplete browser cleanup", () => {
    const { local, session } = installStorage();
    session.setItem("synthetic-token", "old");
    vi.spyOn(local, "removeItem").mockImplementation(() => {
      throw new Error("Blocked delete");
    });
    expect(() => authStorage.removeItem("synthetic-token")).toThrow(AppError);
    expect(session.getItem("synthetic-token")).toBeNull();
  });
});
