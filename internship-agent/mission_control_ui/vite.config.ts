import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `npm run build` writes dist/, which app_server.py serves at http://127.0.0.1:4760.
// `npm run dev` serves the page with hot reload and forwards /api to a running app_server.py.
export default defineConfig({
  plugins: [react()],
  base: "/",
  build: { outDir: "dist", emptyOutDir: true, sourcemap: false },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: { "/api": { target: "http://127.0.0.1:4760", changeOrigin: true } },
  },
});
