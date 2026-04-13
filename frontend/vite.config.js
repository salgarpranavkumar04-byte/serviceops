import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * vite.config.js (v5 — ALIGNED)
 *
 * Dev proxy: all backend API paths forwarded to Express server.
 * In production, reverse-proxy these paths in nginx/caddy to the backend.
 */
export default defineConfig({
  plugins: [react()],

  server: {
    port: 3000,
    proxy: {
      // Authenticated admin routes → Express /admin (requires x-api-key)
      '/admin': {
        target:      'http://localhost:8000',
        changeOrigin: true,
      },
      // Jobs lifecycle routes (requires x-api-key)
      '/jobs': {
        target:      'http://localhost:8000',
        changeOrigin: true,
      },
      // Wallet routes (requires x-api-key)
      '/wallet': {
        target:      'http://localhost:8000',
        changeOrigin: true,
      },
      // Conversation routes (requires x-api-key)
      '/conversations': {
        target:      'http://localhost:8000',
        changeOrigin: true,
      },
      // Public technician list
      '/technicians': {
        target:      'http://localhost:8000',
        changeOrigin: true,
      },
      // Public health check
      '/health': {
        target:      'http://localhost:8000',
        changeOrigin: true,
      },
    },
  },

  build: {
    outDir:     'dist',
    sourcemap:  false,
    minify:     'esbuild',
    target:     'es2020',
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom'],
        },
      },
    },
  },
});
