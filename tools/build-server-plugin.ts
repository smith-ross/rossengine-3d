// Vite plugin that gives the in-browser editor a local "build server":
//   GET  /api/status  -> player template state
//   POST /api/build   -> package the place as a standalone Electron app in builds/
//   POST /api/reveal  -> show a built game in the OS file manager
//   GET  /api/zip     -> download a built game as a .zip
import type { Plugin, Connect } from 'vite'
import type { IncomingMessage, ServerResponse } from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { Zip, ZipDeflate } from 'fflate'

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(body))
}

function middleware(): Connect.NextHandleFunction {
  return async (req, res, next) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (!url.pathname.startsWith('/api/')) return next()
    // loaded lazily so the editor still works if packaging deps are missing
    const pb = await import('./player-build.ts')
    try {
      if (url.pathname === '/api/status' && req.method === 'GET') {
        return json(res, 200, { template: pb.templateUpToDate(), platforms: [process.platform], host: process.platform })
      }
      if (url.pathname === '/api/build' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req))
        if (!body?.place?.root) return json(res, 400, { ok: false, error: 'Missing place data' })
        const logs: string[] = []
        const r = await pb.exportGame(String(body.name ?? 'Game'), JSON.stringify(body.place), body.platform || process.platform, (m) => {
          logs.push(m)
          console.log('[build]', m)
        })
        return json(res, 200, { ok: true, dir: r.dir, exe: r.exe, logs, zip: `./api/zip?dir=${encodeURIComponent(path.basename(r.dir))}` })
      }
      if (url.pathname === '/api/reveal' && req.method === 'POST') {
        const { path: p } = JSON.parse(await readBody(req))
        const target = path.resolve(String(p))
        if (!target.startsWith(pb.BUILDS_DIR) || !fs.existsSync(target)) return json(res, 400, { ok: false })
        if (process.platform === 'win32') spawn('explorer.exe', [`/select,${target}`], { detached: true })
        else if (process.platform === 'darwin') spawn('open', ['-R', target], { detached: true })
        else spawn('xdg-open', [path.dirname(target)], { detached: true })
        return json(res, 200, { ok: true })
      }
      if (url.pathname === '/api/zip' && req.method === 'GET') {
        const name = path.basename(url.searchParams.get('dir') ?? '')
        const dir = path.join(pb.BUILDS_DIR, name)
        if (!name || !fs.existsSync(dir)) return json(res, 404, { ok: false, error: 'Build not found' })
        res.setHeader('content-type', 'application/zip')
        res.setHeader('content-disposition', `attachment; filename="${name}.zip"`)
        const zip = new Zip((err, chunk, final) => {
          if (err) { res.destroy(err); return }
          res.write(chunk)
          if (final) res.end()
        })
        const walk = (p: string, rel: string) => {
          for (const f of fs.readdirSync(p)) {
            const full = path.join(p, f), r = rel ? `${rel}/${f}` : f
            if (fs.statSync(full).isDirectory()) walk(full, r)
            else {
              const entry = new ZipDeflate(`${name}/${r}`, { level: 6 })
              zip.add(entry)
              entry.push(fs.readFileSync(full), true)
            }
          }
        }
        walk(dir, '')
        zip.end()
        return
      }
      return json(res, 404, { ok: false, error: 'Unknown endpoint' })
    } catch (e) {
      console.error(e)
      return json(res, 500, { ok: false, error: String((e as Error)?.stack ?? e) })
    }
  }
}

export function buildServerPlugin(): Plugin {
  return {
    name: 'rossengine-build-server',
    configureServer(server) { server.middlewares.use(middleware()) },
    configurePreviewServer(server) { server.middlewares.use(middleware()) },
  }
}
