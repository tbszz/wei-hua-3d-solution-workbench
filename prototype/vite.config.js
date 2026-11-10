import { defineConfig } from 'vite';

// /api and /library go to the workbench backend (Express, 8787), which also forwards /api/llm
// to the OpenAI-compatible model endpoint so the key and CORS stay server-side.
// /llm is kept as a direct fallback to the local magpie proxy; override with LLM_TARGET.
const backend = process.env.BACKEND_TARGET ?? 'http://127.0.0.1:8787';
const llm = process.env.LLM_TARGET ?? 'http://127.0.0.1:7897';

export default defineConfig({
  publicDir: '../data',
  resolve: { dedupe: ['three', 'dxf-parser'] },
  server: {
    fs: { allow: ['..'] },
    proxy: {
      '/api': { target: backend, changeOrigin: true },
      '/library': { target: backend, changeOrigin: true },
      '/llm': { target: llm, changeOrigin: true, rewrite: (path) => path.replace(/^\/llm/, '/v1') },
    },
  },
  build: { chunkSizeWarningLimit: 2000 },
});
