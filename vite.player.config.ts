import { defineConfig } from 'vite'
import { resolve } from 'node:path'

// Builds only the game runtime (no editor, no Monaco) for the Electron player.
export default defineConfig({
  base: './',
  root: import.meta.dirname,
  publicDir: false,
  build: {
    outDir: 'player-build/app/runtime',
    emptyOutDir: true,
    target: 'es2022',
    chunkSizeWarningLimit: 8000,
    rollupOptions: { input: { player: resolve(import.meta.dirname, 'player.html') } },
  },
})
