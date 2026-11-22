// Opening/saving .rbe place files (File System Access API when available, download/upload otherwise).
import { editor, PlaceFile } from './store'

const EXT = '.rbe'
const pickerTypes = [{ description: 'RossEngine place', accept: { 'application/json': [EXT, '.json'] } }]

export async function openPlace() {
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

export async function savePlace(saveAs = false) {
  if (editor.playing) { editor.log('warn', 'Stop the game before saving.'); return }
  const text = JSON.stringify(editor.toFile(), null, 1)
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
      return
    }
  } catch (e) {
    if ((e as Error).name === 'AbortError') return
    editor.log('warn', `Save failed (${(e as Error).message}); downloading instead.`)
  }
  download(safeName(editor.placeName) + EXT, text)
  editor.dirty = false
  editor.log('system', `Downloaded "${editor.placeName}${EXT}"`)
  editor.emit()
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
