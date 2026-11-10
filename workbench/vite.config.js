import { defineConfig } from 'vite';
import path from 'node:path';
export default defineConfig({ root: '.', publicDir: process.env.NODE_ENV === 'production' ? false : 'public', cacheDir: '../demo/.workbench-vite-cache', server: { port: 5181, strictPort: true, proxy: { '/api': 'http://127.0.0.1:8787' }, fs: { allow: [path.resolve('..')] } }, build: { outDir: 'dist', assetsDir: '.', emptyOutDir: false } });

