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
      registerType: "autoUpdate",
      // Chế độ injectManifest: src/sw.ts là Service Worker thật, tự tái lập
      // 1:1 hành vi generateSW cũ (skipWaiting/clientsClaim/autoUpdate, precache
      // shell, navigation fallback, 3 route CacheFirst OCR + ảnh Tết, không bao
      // giờ cache /rest|/auth|/functions) rồi mới cộng lớp push. Gate
      // check-pwa / check-pwa-upgrade / check-pwa-release-skew kiểm HÀNH VI
      // trên dist nên hợp đồng an toàn giữ nguyên khi đổi chiến lược.
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
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
      // Cấu hình sinh precache cho sw.ts (tương đương 100% khối workbox của
      // generateSW cũ). Runtime caching KHÔNG khai báo ở đây — sw.ts đăng ký
      // đúng 3 route bằng code, có kiểm soát (pushContracts + check-pwa).
      injectManifest: {
        globPatterns: ["**/*.{js,css,html,svg,png,woff2}"],
        // The Tesseract WASM runtime (~13 MB) must never be precached with the
        // app shell; the OCR worker fetches it on demand and CacheFirst keeps
        // it for offline scanning afterwards. The Dê Lái cinematic artwork
        // (2.3 MB — over workbox's 2 MiB precap) belongs to the optional Tết
        // opening only: it loads on demand the first time the OWNER enables the
        // cinematic, then the same runtime pattern keeps that device's opener
        // playable offline. DEFAULT sessions never fetch any of it.
        globIgnores: ["**/tesseract/**", "**/tet-de-lai.png"],
      },
      devOptions: { enabled: false },
    }),
  ],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  build: {
    rollupOptions: {
      output: {
        // Carve stable vendor libraries into isolated cache chunks
        // to enable parallel downloading, faster execution and long-term HTTP caching.
        manualChunks(id) {
          if (id.includes("node_modules")) {
            if (id.includes("@zxing") || id.includes("html5-qrcode")) {
              return "vendor-scanner";
            }
            if (id.includes("@supabase")) {
              return "supabase";
            }
            if (id.includes("@tanstack")) {
              return "query";
            }
            if (
              id.includes("react-router") ||
              id.includes("react-dom") ||
              id.includes("/react/")
            ) {
              return "react";
            }
            if (id.includes("lucide-react")) {
              return "vendor-icons";
            }
          }
        },
      },
    },
  },
});
