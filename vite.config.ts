import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
import { buildServerPlugin } from './tools/build-server-plugin.ts'

// Two entry points:
//  - index.html  -> the in-browser editor (React + Monaco)
//  - player.html -> the standalone game runtime (loaded by the Electron player)
export default defineConfig({
  base: './',
  plugins: [react(), buildServerPlugin()],
  resolve: {
    alias: {
      // direct access to monaco's ESM sources (lets us skip the 80+ bundled languages)
      'monaco-esm': resolve(import.meta.dirname, 'node_modules/monaco-editor/esm/vs'),
    },
  },
  server: { port: 5173 },
  build: {
    outDir: 'dist',
    target: 'es2022',
    chunkSizeWarningLimit: 8000,
    rollupOptions: {
      input: {
        editor: resolve(import.meta.dirname, 'index.html'),
        player: resolve(import.meta.dirname, 'player.html'),
      },
    },
  },
  optimizeDeps: {
    exclude: ['@luau-rs/luau'],
  },
})
