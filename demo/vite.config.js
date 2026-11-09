import { defineConfig } from 'vite';

export default defineConfig({
  publicDir: '../data',
  server: { fs: { allow: ['..'] } },
});
