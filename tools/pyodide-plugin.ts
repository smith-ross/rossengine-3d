// Serves Pyodide's runtime files at ./pyodide/ in dev and copies them into builds (editor and player),
// so Python works offline (including in the Electron player).
import type { Plugin } from 'vite'
import fs from 'node:fs'
import path from 'node:path'

const DIR = path.resolve(import.meta.dirname, '..', 'node_modules', 'pyodide')
const FILES = ['pyodide.asm.mjs', 'pyodide.asm.wasm', 'python_stdlib.zip', 'pyodide-lock.json', 'pyodide.mjs']
const MIME: Record<string, string> = {
  '.mjs': 'text/javascript', '.js': 'text/javascript', '.wasm': 'application/wasm', '.zip': 'application/zip', '.json': 'application/json',
}

export function pyodidePlugin(): Plugin {
  let outDir = 'dist'
  return {
    name: 'rossengine-pyodide',
    configResolved(c) { outDir = path.resolve(c.root, c.build.outDir) },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const m = /\/pyodide\/([\w.-]+)$/.exec((req.url ?? '').split('?')[0])
        if (!m || !FILES.includes(m[1])) return next()
        const file = path.join(DIR, m[1])
        res.setHeader('content-type', MIME[path.extname(file)] ?? 'application/octet-stream')
        fs.createReadStream(file).pipe(res)
      })
    },
    writeBundle() {
      const dest = path.join(outDir, 'pyodide')
      fs.mkdirSync(dest, { recursive: true })
      for (const f of FILES) fs.copyFileSync(path.join(DIR, f), path.join(dest, f))
    },
  }
}
