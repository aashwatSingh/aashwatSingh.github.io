/**
 * @author eLeet Coderz (Team 3) - build setup: Saaqib Shaik
 * @description Build and dev-server settings. In development the React app runs on port 5173 and forwards
 *   every /api request and the /ws live-update socket to the FastAPI backend on port 8000, so the browser
 *   only ever talks to one address. Also configures the Vitest unit tests.
 * @traces SE-NFR-04, SE-NFR-10, SE-NFR-12
 */
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

declare const process: { env: Record<string, string | undefined> };

const backend = process.env.VITE_BACKEND_URL ?? 'http://127.0.0.1:8000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: backend, changeOrigin: true },
      '/ws': { target: backend.replace(/^http/, 'ws'), ws: true, changeOrigin: true },
    },
  },
  build: { outDir: 'dist', sourcemap: false, chunkSizeWarningLimit: 900 },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
});
