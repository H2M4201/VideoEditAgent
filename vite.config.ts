import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The UI lives in src/web and is built to dist/web, which `src/server/main.ts` serves.
const API = 'http://127.0.0.1:4317';

export default defineConfig({
  root: path.resolve(import.meta.dirname, 'src/web'),
  plugins: [react()],
  build: { outDir: path.resolve(import.meta.dirname, 'dist/web'), emptyOutDir: true },
  server: { proxy: { '/api': API, '/media': API } },
});
