// Place-level asset store. Files (sounds, images, meshes) are imported into the place and saved
// inside the place file, so games never depend on external IDs or URLs.
// Properties reference them as "asset://<id>" (scripts may also use "asset://<name>").

export type AssetKind = 'audio' | 'image' | 'mesh'

export interface Asset {
  id: string
  name: string
  kind: AssetKind
  mime: string
  bytes: Uint8Array
}

/** Serialized form inside place files. */
export interface SerializedAsset { id: string; name: string; kind: AssetKind; mime: string; data: string }

export const ASSET_PREFIX = 'asset://'

const EXT: Record<string, [AssetKind, string]> = {
  mp3: ['audio', 'audio/mpeg'], ogg: ['audio', 'audio/ogg'], wav: ['audio', 'audio/wav'], m4a: ['audio', 'audio/mp4'],
  flac: ['audio', 'audio/flac'], webm: ['audio', 'audio/webm'],
  png: ['image', 'image/png'], jpg: ['image', 'image/jpeg'], jpeg: ['image', 'image/jpeg'], gif: ['image', 'image/gif'],
  webp: ['image', 'image/webp'], svg: ['image', 'image/svg+xml'], bmp: ['image', 'image/bmp'],
  glb: ['mesh', 'model/gltf-binary'], gltf: ['mesh', 'model/gltf+json'], obj: ['mesh', 'model/obj'],
  fbx: ['mesh', 'application/octet-stream'], stl: ['mesh', 'model/stl'],
}

export const ACCEPT: Record<AssetKind, string> = {
  audio: '.mp3,.ogg,.wav,.m4a,.flac,.webm',
  image: '.png,.jpg,.jpeg,.gif,.webp,.svg,.bmp',
  mesh: '.glb,.gltf,.obj,.fbx,.stl',
}

export function extOf(name: string) {
  const i = name.lastIndexOf('.')
  return i < 0 ? '' : name.slice(i + 1).toLowerCase()
}

export function kindOfFile(name: string): AssetKind | null {
  return EXT[extOf(name)]?.[0] ?? null
}

function toBase64(bytes: Uint8Array) {
  let s = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) s += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  return btoa(s)
}
function fromBase64(b64: string) {
  const s = atob(b64)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

function newId() {
  return (globalThis.crypto?.randomUUID?.() ?? String(Math.random()).slice(2)).replace(/-/g, '').slice(0, 10)
}

export class AssetStore {
  private assets = new Map<string, Asset>()
  private urls = new Map<string, string>()
  private listeners = new Set<() => void>()
  version = 0

  list(kind?: AssetKind) {
    return [...this.assets.values()].filter((a) => !kind || a.kind === kind).sort((a, b) => a.name.localeCompare(b.name))
  }
  get(id: string) { return this.assets.get(id) }

  /** Resolve a content string to an asset (by id, then by name). */
  resolve(content: string | null | undefined): Asset | null {
    if (!content || !content.startsWith(ASSET_PREFIX)) return null
    const key = content.slice(ASSET_PREFIX.length)
    return this.assets.get(key) ?? [...this.assets.values()].find((a) => a.name === key) ?? null
  }

  /** URL usable by the browser for a content string; http(s)/data/blob URLs pass through. */
  url(content: string | null | undefined): string | null {
    if (!content) return null
    if (/^(https?:|data:|blob:)/.test(content)) return content
    const a = this.resolve(content)
    if (!a) return null
    let u = this.urls.get(a.id)
    if (!u) {
      u = URL.createObjectURL(new Blob([a.bytes as BlobPart], { type: a.mime }))
      this.urls.set(a.id, u)
    }
    return u
  }

  async importFile(file: File): Promise<Asset> {
    const ext = extOf(file.name)
    const info = EXT[ext]
    if (!info) throw new Error(`Unsupported file type ".${ext}". Supported: ${Object.values(ACCEPT).join(',')}`)
    const bytes = new Uint8Array(await file.arrayBuffer())
    const base = file.name.replace(/\.[^.]+$/, '')
    let name = base
    for (let n = 2; this.list().some((a) => a.name === name); n++) name = `${base} (${n})`
    const asset: Asset = { id: newId(), name, kind: info[0], mime: file.type || info[1], bytes }
    this.assets.set(asset.id, asset)
    this.changed()
    return asset
  }

  rename(id: string, name: string) {
    const a = this.assets.get(id)
    if (a && name.trim()) { a.name = name.trim(); this.changed() }
  }

  remove(id: string) {
    const u = this.urls.get(id)
    if (u) URL.revokeObjectURL(u)
    this.urls.delete(id)
    this.assets.delete(id)
    this.changed()
  }

  clear() {
    for (const u of this.urls.values()) URL.revokeObjectURL(u)
    this.urls.clear()
    this.assets.clear()
    this.changed()
  }

  serialize(): SerializedAsset[] {
    return this.list().map((a) => ({ id: a.id, name: a.name, kind: a.kind, mime: a.mime, data: toBase64(a.bytes) }))
  }

  load(list: SerializedAsset[] | undefined) {
    this.clear()
    for (const s of list ?? []) {
      try { this.assets.set(s.id, { id: s.id, name: s.name, kind: s.kind, mime: s.mime, bytes: fromBase64(s.data) }) } catch { /* skip corrupt */ }
    }
    this.changed()
  }

  totalBytes() { let n = 0; for (const a of this.assets.values()) n += a.bytes.length; return n }

  subscribe(fn: () => void) { this.listeners.add(fn); return () => { this.listeners.delete(fn) } }
  private changed() { this.version++; for (const l of this.listeners) l() }
}

/** The assets of the currently loaded place (shared by the editor, Play mode and the player). */
export const assets = new AssetStore()

export function contentRef(a: Asset) { return ASSET_PREFIX + a.id }
