import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  if (env.VITE_PUBLIC_SITE === "true" && env.VITE_MANAGED_SITE === "true")
    throw new Error("Choose one UI edition: public or managed.");
  const edition =
    env.VITE_PUBLIC_SITE === "true"
      ? "public"
      : env.VITE_MANAGED_SITE === "true"
        ? "managed"
        : "community";
  return {
    base: process.env.CHRONOGRAPH_SITE_BASE || "/",
    plugins: [
      react(),
      {
        name: "chronodb-edition",
        transformIndexHtml() {
          return [
            {
              tag: "meta",
              attrs: { name: "chronodb-edition", content: edition },
              injectTo: "head-prepend",
            },
          ];
        },
        generateBundle() {
          this.emitFile({
            type: "asset",
            fileName: "chronodb-build.json",
            source: JSON.stringify({ edition, schemaVersion: 1 }) + "\n",
          });
        },
      },
    ],
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
  };
});
