import { defineConfig } from 'vite';
import { resolve } from 'path';

// The backend serves HTTPS only when cert.pem/key.pem exist; this target is
// hard-coded to https, so those certs are required for the dev workflow.
const target = 'https://localhost:8340';

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      '/api': { target, secure: false },
      '/ws': { target, secure: false, ws: true },
    },
  },
  build: {
    rollupOptions: { input: { main: resolve(__dirname, 'index.html'), dashboard: resolve(__dirname, 'dashboard.html') } },
  },
  plugins: [{
    name: 'dashboard-route',
    configureServer(s) {
      s.middlewares.use((req, _res, next) => { if (req.url === '/dashboard') req.url = '/dashboard.html'; next(); });
    },
  }],
});
