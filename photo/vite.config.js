import { defineConfig } from 'vite';

// Product models and the sample photo live in ../data, the vehicle loader in ../demo/src.
export default defineConfig({
  publicDir: '../data',
  resolve: { dedupe: ['three'] },
  server: { fs: { allow: ['..'] } },
});
