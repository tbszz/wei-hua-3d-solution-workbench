import { defineConfig } from 'vite';

// The page talks to an OpenAI-compatible endpoint through /llm, so the key and CORS stay on the dev server.
// Default target is the local magpie proxy; override with LLM_TARGET.
const target = process.env.LLM_TARGET ?? 'http://127.0.0.1:7897';

export default defineConfig({
  publicDir: '../data',
  resolve: { dedupe: ['three', 'dxf-parser'] },
  server: {
    fs: { allow: ['..'] },
    proxy: {
      '/llm': { target, changeOrigin: true, rewrite: (path) => path.replace(/^\/llm/, '/v1') },
    },
  },
  build: { chunkSizeWarningLimit: 2000 },
});
