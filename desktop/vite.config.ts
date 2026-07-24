import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const host = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.TAURI_DEV_HOST;
const backendUrl =
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
    ?.VITE_BACKEND_URL ?? "http://127.0.0.1:8765";

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    proxy: {
      "/backend": {
        target: backendUrl,
        changeOrigin: true,
        ws: true,
        rewrite: (path) => path.replace(/^\/backend/, ""),
      },
    },
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
