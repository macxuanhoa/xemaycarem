import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthProvider } from "@/features/auth/AuthProvider";
import App from "./App";
import { installRuntimeMonitoring } from "@/lib/runtimeMonitoring";
import { installSeasonalTheme } from "@/lib/seasonalTheme";
import { preloadCelebration } from "@/lib/celebrate";
import "./styles.css";
// Seasonal layer (Tết 2027). Always bundled; renders nothing until <html
// data-seasonal="tet"> is set. Imported after styles.css so its equal-weight
// `[data-seasonal="tet"] .x` rules win over the plain `[data-theme="dark"] .x`
// overrides, while `[data-seasonal="tet"][data-theme="dark"]` wins over both.
import "./styles-tet.css";
const stopMonitoring = installRuntimeMonitoring();
if (import.meta.hot) import.meta.hot.dispose(stopMonitoring);
const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30000, retry: 1, refetchOnWindowFocus: true },
    mutations: { retry: false, networkMode: "always" },
  },
});
const stopSeasonal = installSeasonalTheme(queryClient);
if (import.meta.hot) import.meta.hot.dispose(stopSeasonal);
// Warm the cinematic dragon chunk while the browser is idle so the sale
// celebration never waits on a network fetch at the moment of joy.
preloadCelebration();
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <App />
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
