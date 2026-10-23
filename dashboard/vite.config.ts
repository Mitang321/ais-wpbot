import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// WhatsApp dashboard SPA. API base URL comes from import.meta.env.VITE_API_URL.
export default defineConfig({
  plugins: [react()],
  server: { port: 5175 },
  preview: { port: 5175 },
  build: { outDir: 'dist', sourcemap: true },
});
