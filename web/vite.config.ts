import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In development the API runs on :3000 (npm run dev in the project root);
// Vite proxies /api so the browser sees a single origin.
// 127.0.0.1, not localhost: Node may resolve localhost to ::1 while the API listens on IPv4.
const apiTarget = process.env.VITE_API_PROXY_TARGET ?? 'http://127.0.0.1:3000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: apiTarget, changeOrigin: true },
    },
  },
});
