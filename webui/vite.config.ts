import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const webuiRoot = fileURLToPath(new URL('.', import.meta.url));
const outDir = path.resolve(webuiRoot, '../dist/daemon-admin-ui');

export default defineConfig({
  root: webuiRoot,
  plugins: [react()],
  base: '/daemon/admin/',
  build: {
    outDir,
    emptyOutDir: true,
    sourcemap: false
  }
});
