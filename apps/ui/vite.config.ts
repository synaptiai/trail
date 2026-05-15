import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Tauri's expected dev server config:
// - Strict port 1420 so the Rust shell can connect.
// - HMR over the same port for the desktop window.
// - clearScreen disabled so Tauri panel logs remain visible.
const TAURI_HOST = process.env['TAURI_DEV_HOST'];

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    host: TAURI_HOST ?? '127.0.0.1',
    port: 1420,
    strictPort: true,
    ...(TAURI_HOST
      ? { hmr: { protocol: 'ws', host: TAURI_HOST, port: 1421 } }
      : {}),
    watch: { ignored: ['**/src-tauri/**'] },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    minify: 'esbuild',
  },
});
