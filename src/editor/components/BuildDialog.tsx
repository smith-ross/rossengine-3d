// "Build Game" dialog: produces a standalone Electron app via the editor's local build server.
import { useEffect, useState } from 'react'
import { editor, useEditor } from '../store'
import { download, exportGameJson, safeName } from '../fileio'
import { desktop } from '../desktop'

interface BuildResult { ok: boolean; dir?: string; exe?: string; error?: string; zip?: string }

export function BuildDialog({ onClose }: { onClose: () => void }) {
  const ed = useEditor()
  const [name, setName] = useState(ed.placeName)
  const [width, setWidth] = useState(ed.settings.width)
  const [height, setHeight] = useState(ed.settings.height)
  const [fullscreen, setFullscreen] = useState(ed.settings.fullscreen)
  const [platform, setPlatform] = useState('win32')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<BuildResult | null>(null)
  const [server, setServer] = useState<{ available: boolean; template: boolean; platforms?: string[] } | null>(null)
  const [outDir, setOutDir] = useState<string | null>(null)
  const [defaultOut, setDefaultOut] = useState('')

  useEffect(() => {
    if (desktop) {
      // RossEngine Studio: builds run in the app itself from its bundled player runtime
      void desktop.info().then((i) => {
        setServer({ available: i.template, template: i.template, platforms: [i.platform] })
        setPlatform(i.platform)
        setDefaultOut(i.buildDir)
      })
      return
    }
    fetch('./api/status').then((r) => (r.ok ? r.json() : null)).then((s) => {
      setServer(s ? { available: true, template: !!s.template, platforms: s.platforms } : { available: false, template: false })
      if (s?.platforms?.length) setPlatform(s.platforms.includes(`${s.host}`) ? s.host : s.platforms[0])
    }).catch(() => setServer({ available: false, template: false }))
  }, [])

  const applySettings = () => {
    editor.placeName = name.trim() || 'Untitled'
    editor.settings = { width, height, fullscreen }
    editor.emit()
  }

  const build = async () => {
    applySettings()
    setBusy(true)
    setResult(null)
    try {
      if (desktop) {
        const r = await desktop.build({ name: safeName(editor.placeName), placeJson: JSON.stringify(editor.toFile()), outDir: outDir ?? undefined })
        setResult(r)
        if (r.ok) editor.log('system', `Built "${editor.placeName}" → ${r.exe ?? r.dir}`)
        else editor.log('error', `Build failed: ${r.error}`)
        return
      }
      const res = await fetch('./api/build', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: safeName(editor.placeName), platform, place: editor.toFile() }),
      })
      const r = (await res.json()) as BuildResult
      setResult(r)
      if (r.ok) editor.log('system', `Built "${editor.placeName}" → ${r.exe ?? r.dir}`)
      else editor.log('error', `Build failed: ${r.error}`)
    } catch (e) {
      setResult({ ok: false, error: String((e as Error).message) })
    } finally {
      setBusy(false)
    }
  }

  const reveal = (path: string) => desktop
    ? desktop.reveal(path)
    : fetch('./api/reveal', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path }) })

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-title">Build Game</div>
        <p className="muted">Packages your place with the RossEngine runtime into a standalone desktop app (Electron). Players only see the game — scripts run exactly as in Play mode.</p>
        <label className="field"><span>Game name</span><input value={name} onChange={(e) => setName(e.target.value)} /></label>
        <div className="field-row">
          <label className="field"><span>Window width</span><input type="number" value={width} onChange={(e) => setWidth(Number(e.target.value))} /></label>
          <label className="field"><span>Window height</span><input type="number" value={height} onChange={(e) => setHeight(Number(e.target.value))} /></label>
          <label className="field check"><input type="checkbox" checked={fullscreen} onChange={(e) => setFullscreen(e.target.checked)} /><span>Start fullscreen</span></label>
        </div>
        {server?.available && (server.platforms?.length ?? 0) > 1 && (
          <label className="field"><span>Platform</span>
            <select value={platform} onChange={(e) => setPlatform(e.target.value)}>
              {server.platforms!.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </label>
        )}
        {desktop && (
          <div className="field">
            <span>Output folder</span>
            <div className="row-inline">
              <code className="path">{outDir ?? defaultOut}</code>
              <button className="btn small" onClick={async () => { const d = await desktop!.chooseBuildDir(); if (d) setOutDir(d) }}>Change…</button>
            </div>
          </div>
        )}
        {desktop && server && !server.available && (
          <div className="notice warn">This Studio installation is missing its RossPlayer runtime, so games can't be built. Reinstall RossEngine Studio.</div>
        )}
        {!desktop && server && !server.available && (
          <div className="notice warn">
            The build server isn't reachable. Start the editor with <code>npm run dev</code> (or <code>npm run editor</code>) to build executables.
            You can still export <code>game.json</code> and drop it next to a RossEngine player.
          </div>
        )}
        {server?.available && !server.template && (
          <div className="notice">The player runtime hasn't been packaged yet — the first build prepares it (takes a minute).</div>
        )}
        {result && (result.ok ? (
          <div className="notice ok">
            Built successfully!<br />
            <code>{result.exe ?? result.dir}</code>
            <div className="row">
              <button className="btn" onClick={() => reveal(result.exe ?? result.dir!)}>Show in folder</button>
              {desktop && result.exe && <button className="btn" onClick={() => desktop!.runGame(result.exe!)}>Run game</button>}
              {!desktop && result.zip && <a className="btn" href={result.zip} download>Download .zip</a>}
            </div>
          </div>
        ) : (
          <div className="notice error">{result.error}</div>
        ))}
        <div className="modal-actions">
          <button className="btn" onClick={() => { applySettings(); exportGameJson() }}>Export game.json</button>
          <button className="btn" onClick={() => { applySettings(); download(safeName(editor.placeName) + '.rbe', JSON.stringify(editor.toFile())) }}>Download place</button>
          <div className="spacer" />
          <button className="btn" onClick={onClose}>Close</button>
          <button className="btn primary" disabled={busy || !server?.available} onClick={build}>{busy ? 'Building…' : 'Build App'}</button>
        </div>
      </div>
    </div>
  )
}
