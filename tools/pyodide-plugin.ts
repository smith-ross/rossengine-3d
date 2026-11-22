// Serves runtime support files in dev and copies them into builds (editor and player), so they work
// offline (including in the Electron player):
//   ./pyodide/  Pyodide (Python)        ./draco/  Draco mesh decoder (compressed glTF models)
import type { Plugin } from 'vite'
import fs from 'node:fs'
import path from 'node:path'

const NM = path.resolve(import.meta.dirname, '..', 'node_modules')
const DIRS: Record<string, { dir: string; files: string[] }> = {
  pyodide: { dir: path.join(NM, 'pyodide'), files: ['pyodide.asm.mjs', 'pyodide.asm.wasm', 'python_stdlib.zip', 'pyodide-lock.json', 'pyodide.mjs'] },
  draco: { dir: path.join(NM, 'three', 'examples', 'jsm', 'libs', 'draco', 'gltf'), files: ['draco_decoder.js', 'draco_decoder.wasm', 'draco_wasm_wrapper.js'] },
}
const MIME: Record<string, string> = {
  '.mjs': 'text/javascript', '.js': 'text/javascript', '.wasm': 'application/wasm', '.zip': 'application/zip', '.json': 'application/json',
}

export function pyodidePlugin(): Plugin {
  let outDir = 'dist'
  return {
    name: 'rossengine-runtime-files',
    configResolved(c) { outDir = path.resolve(c.root, c.build.outDir) },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const m = /\/(pyodide|draco)\/([\w.-]+)$/.exec((req.url ?? '').split('?')[0])
        const entry = m && DIRS[m[1]]
        if (!m || !entry || !entry.files.includes(m[2])) return next()
        const file = path.join(entry.dir, m[2])
        res.setHeader('content-type', MIME[path.extname(file)] ?? 'application/octet-stream')
        fs.createReadStream(file).pipe(res)
      })
    },
    writeBundle() {
      for (const [name, entry] of Object.entries(DIRS)) {
        const dest = path.join(outDir, name)
        fs.mkdirSync(dest, { recursive: true })
        for (const f of entry.files) fs.copyFileSync(path.join(entry.dir, f), path.join(dest, f))
      }
    },
  }
}
