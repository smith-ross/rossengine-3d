// Opening/saving .rbe place files (File System Access API when available, download/upload otherwise).
import { editor, PlaceFile } from './store'
import { desktop } from './desktop'

const EXT = '.rbe'
const pickerTypes = [{ description: 'RossEngine place', accept: { 'application/json': [EXT, '.json'] } }]

export async function openPlace() {
  if (desktop) {
    const r = await desktop.open()
    if (!r) return
    try { editor.openFile(JSON.parse(r.text) as PlaceFile, { desktopToken: r.token, name: r.name }) } catch (e) { editor.log('error', `Could not open ${r.name}: ${(e as Error).message}`) }
    return
  }
  try {
    if ('showOpenFilePicker' in window) {
      const [handle] = await (window as any).showOpenFilePicker({ types: pickerTypes })
      const file = await handle.getFile()
      editor.openFile(JSON.parse(await file.text()) as PlaceFile, handle)
      return
    }
  } catch (e) {
    if ((e as Error).name === 'AbortError') return
  }
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = `${EXT},.json`
  input.onchange = async () => {
    const f = input.files?.[0]
    if (!f) return
    try { editor.openFile(JSON.parse(await f.text()) as PlaceFile) } catch (e) { editor.log('error', `Could not open file: ${(e as Error).message}`) }
  }
  input.click()
}

/** Save the place; resolves true if it was written. */
export async function savePlace(saveAs = false): Promise<boolean> {
  if (editor.playing) { editor.log('warn', 'Stop the game before saving.'); return false }
  const text = JSON.stringify(editor.toFile(), null, 1)
  if (desktop) {
    try {
      const tokenNow = saveAs ? null : editor.fileHandle?.desktopToken
      const r = tokenNow ? await desktop.save(tokenNow, text) : await desktop.saveAs(safeName(editor.placeName), text)
      if (!r) return false
      editor.fileHandle = { desktopToken: r.token, name: r.name }
      editor.dirty = false
      editor.log('system', `Saved "${editor.placeName}" to ${r.name}`)
      editor.emit()
      return true
    } catch (e) {
      editor.log('error', `Save failed: ${(e as Error).message}`)
      return false
    }
  }
  try {
    if ('showSaveFilePicker' in window) {
      let handle = saveAs ? null : editor.fileHandle
      if (!handle) {
        handle = await (window as any).showSaveFilePicker({ suggestedName: safeName(editor.placeName) + EXT, types: pickerTypes })
      }
      const w = await handle.createWritable()
      await w.write(text)
      await w.close()
      editor.fileHandle = handle
      editor.dirty = false
      editor.log('system', `Saved "${editor.placeName}" to ${handle.name}`)
      editor.emit()
      return true
    }
  } catch (e) {
    if ((e as Error).name === 'AbortError') return false
    editor.log('warn', `Save failed (${(e as Error).message}); downloading instead.`)
  }
  download(safeName(editor.placeName) + EXT, text)
  editor.dirty = false
  editor.log('system', `Downloaded "${editor.placeName}${EXT}"`)
  editor.emit()
  return true
}

export function exportGameJson() {
  download('game.json', JSON.stringify(editor.toFile()))
}

export function download(name: string, text: string | Blob) {
  const blob = typeof text === 'string' ? new Blob([text], { type: 'application/json' }) : text
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 5000)
}

export function safeName(n: string) {
  return n.replace(/[^\w\- ]+/g, '').trim() || 'Game'
}
