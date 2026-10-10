import { supabase } from "./supabase";
import { createRuntimeReporter, type RuntimeIssue } from "./runtimeIssueCore";

const reporter = createRuntimeReporter({
  online: () => typeof navigator === "undefined" || navigator.onLine,
  send: async (issue) => {
    if (!supabase) return "disabled";
    const { data: session } = await supabase.auth.getSession();
    if (!session.session) return "sent";
    // Direct RPC deliberately avoids api.call and telemetry recursion.
    const { error } = await supabase.rpc("report_client_issue", {
      p_data: issue,
    });
    if (
      error?.code === "PGRST202" ||
      error?.code === "42883" ||
      error?.code === "42501"
    )
      return "disabled";
    return error ? "retry" : "sent";
  },
});

export function reportRuntimeIssue(
  source: RuntimeIssue["source"],
  code: RuntimeIssue["code"],
  operation = "other",
): void {
  reporter.report({
    source,
    code,
    operation,
    route: typeof window === "undefined" ? "/other" : window.location.pathname,
    release: import.meta.env.VITE_APP_RELEASE,
    environment:
      import.meta.env.VITE_APP_ENV ??
      (import.meta.env.DEV ? "development" : "production"),
  });
}

let installed = false;
export function installRuntimeMonitoring(): () => void {
  if (installed || typeof window === "undefined") return () => {};
  installed = true;
  const error = () => reportRuntimeIssue("global", "JS_ERROR", "global");
  const rejection = () =>
    reportRuntimeIssue("promise", "UNHANDLED_REJECTION", "global");
  const online = () => {
    void reporter.flush();
  };
  window.addEventListener("error", error);
  window.addEventListener("unhandledrejection", rejection);
  window.addEventListener("online", online);
  return () => {
    installed = false;
    window.removeEventListener("error", error);
    window.removeEventListener("unhandledrejection", rejection);
    window.removeEventListener("online", online);
  };
}
