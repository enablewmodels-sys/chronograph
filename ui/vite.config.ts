import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  base: process.env.CHRONOGRAPH_SITE_BASE || "/",
  plugins: [react()],
  // Keep font assets same-origin rather than data URLs to match the CSP.
  build: { assetsInlineLimit: 0 },
  server: {
    proxy: {
      "/v1": {
        target: "http://127.0.0.1:8080",
        changeOrigin: true,
        // Loopback-only development proxy. Production serves UI/API on one origin.
        configure(proxy) {
          proxy.on("proxyReq", (req) =>
            req.setHeader("Origin", "http://127.0.0.1:8080"),
          );
        },
      },
      "/docs": { target: "http://127.0.0.1:8080", changeOrigin: true },
      "/healthz": { target: "http://127.0.0.1:8080", changeOrigin: true },
    },
  },
});
