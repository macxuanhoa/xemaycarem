import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";
import { fileURLToPath, URL } from "node:url";
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: "prompt",
      includeAssets: ["logo.jpg", "avtcarem.jpg", "icon-192.png", "icon-512.png", "icon-maskable.png"],
      manifest: {
        name: "Cà Rem - Quản Lý Cửa Hàng Xe",
        short_name: "Cà Rem",
        description: "Quản lý kho xe máy và hoạt động cửa hàng Cà Rem",
        lang: "vi",
        start_url: "/",
        scope: "/",
        display: "standalone",
        background_color: "#f7f7f9",
        theme_color: "#12090c",
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
          {
            src: "/icon-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "any",
          },
          {
            src: "/icon-maskable.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png,woff2}"],
        navigateFallback: "/index.html",
        cleanupOutdatedCaches: true,
        runtimeCaching: [],
      },
      devOptions: { enabled: false },
    }),
  ],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  build: {
    rollupOptions: {
      output: {
        // Carve the stable, large third-party libraries out of the entry chunk
        // so the browser downloads them in parallel and keeps them cached across
        // app deploys (their content hash only changes when the lib changes).
        // This trims repeat-visit payload and speeds first-load parsing.
        manualChunks: {
          react: ["react", "react-dom", "react-router-dom"],
          query: ["@tanstack/react-query"],
          supabase: ["@supabase/supabase-js"],
        },
      },
    },
  },
});
