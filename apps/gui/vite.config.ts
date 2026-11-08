import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// dev 代理：/mdp-api/* → hub 7800（避免 CORS；生产由 hub 静态托管后同源直连）
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/mdp-api': {
        target: 'http://127.0.0.1:7800',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/mdp-api/, ''),
      },
    },
  },
  build: { outDir: 'dist' },
});
