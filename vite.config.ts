import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/ws': { target: 'ws://localhost:3001', ws: true },
      '/pty': { target: 'ws://localhost:3001', ws: true },
      '/api': {
        target: 'http://localhost:3001',
        // Default proxy timeout (5s) è troppo corto per endpoint AI: la
        // generazione del commit message richiede ~7-15s.
        timeout: 60_000,
        proxyTimeout: 60_000,
      },
    },
  },
});
