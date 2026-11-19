import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const guiRoot = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: guiRoot,
  plugins: [react()],
  build: {
    outDir: resolve(guiRoot, 'dist'),
    emptyOutDir: true,
  },
});
