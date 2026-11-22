// `npm run studio`: run RossEngine Studio against the Vite dev server (start `npm run dev` first).
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)
const electron = require('electron')
const url = process.env.ROSS_STUDIO_URL || 'http://localhost:5173'
const child = spawn(electron, [path.join(import.meta.dirname, '..', 'electron', 'studio-main.cjs')], {
  stdio: 'inherit', env: { ...process.env, ROSS_STUDIO_URL: url },
})
child.on('exit', (code) => process.exit(code ?? 0))
