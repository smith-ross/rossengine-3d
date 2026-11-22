// Place-level asset store. Files (sounds, images, meshes) are imported into the place and saved
// inside the place file, so games never depend on external IDs or URLs.
// Properties reference them as "asset://<id>" (scripts may also use "asset://<name>").

export type AssetKind = 'audio' | 'image' | 'mesh'

export interface Asset {
  id: string
  name: string
  kind: AssetKind
  mime: string
  /** original file extension (glb, gltf, obj, fbx, stl, png, ...) */
  ext: string
  bytes: Uint8Array
  /** files a model references (.bin buffers, .mtl, textures), keyed by relative path */
  files?: Map<string, Uint8Array>
}

/** Serialized form inside place files. */
export interface SerializedAsset { id: string; name: string; kind: AssetKind; mime: string; ext?: string; data: string; files?: Record<string, string> }

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
  // .bin/.mtl/textures are imported together with a model; .zip can hold a whole model folder
  mesh: '.glb,.gltf,.obj,.fbx,.stl,.bin,.mtl,.zip,.png,.jpg,.jpeg,.webp,.ktx2',
}
/** Files that belong to a multi-file model rather than being assets of their own. */
export const COMPANION_EXT = new Set(['bin', 'mtl', 'png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'tga', 'ktx2', 'dds'])
const MODEL_EXT = new Set(['gltf', 'obj', 'fbx'])

export function extOf(name: string) {
  const i = name.lastIndexOf('.')
  return i < 0 ? '' : name.slice(i + 1).toLowerCase()
}

export function kindOfFile(name: string): AssetKind | null {
  return EXT[extOf(name)]?.[0] ?? null
}
export const isMultiFileModel = (name: string) => MODEL_EXT.has(extOf(name))

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

  private companionUrls = new Map<string, string>()
  /** Blob URL for a model's companion file (matched by relative path, then by file name). */
  companionUrl(a: Asset, ref: string): string | null {
    if (!a.files?.size) return null
    const clean = decodeURIComponent(ref).replace(/\\/g, '/').replace(/^\.\//, '').split('?')[0].toLowerCase()
    const base = clean.split('/').pop()!
    let hit: [string, Uint8Array] | undefined
    for (const e of a.files) {
      const k = e[0].toLowerCase()
      if (k === clean || clean.endsWith('/' + k) || k.endsWith('/' + clean)) { hit = e; break }
    }
    if (!hit) for (const e of a.files) if (e[0].toLowerCase().split('/').pop() === base) { hit = e; break }
    if (!hit) return null
    const key = a.id + '/' + hit[0]
    let u = this.companionUrls.get(key)
    if (!u) {
      const ext = extOf(hit[0])
      const type = EXT[ext]?.[1] ?? (ext === 'bin' ? 'application/octet-stream' : 'application/octet-stream')
      u = URL.createObjectURL(new Blob([hit[1] as BlobPart], { type }))
      this.companionUrls.set(key, u)
    }
    return u
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

  async importFile(file: File, companions?: Map<string, Uint8Array>): Promise<Asset> {
    return this.importBytes(file.name, new Uint8Array(await file.arrayBuffer()), companions)
  }

  /** Add an asset from raw bytes. The type always comes from the extension (browsers often report models as octet-stream). */
  importBytes(fileName: string, bytes: Uint8Array, companions?: Map<string, Uint8Array>): Asset {
    const ext = extOf(fileName)
    const info = EXT[ext]
    if (!info) throw new Error(`Unsupported file type ".${ext}"`)
    const base = fileName.split(/[\\/]/).pop()!.replace(/\.[^.]+$/, '')
    let name = base
    for (let n = 2; this.list().some((a) => a.name === name); n++) name = `${base} (${n})`
    const asset: Asset = { id: newId(), name, kind: info[0], mime: info[1], ext, bytes }
    if (companions?.size) asset.files = companions
    this.assets.set(asset.id, asset)
    this.changed()
    return asset
  }

  rename(id: string, name: string) {
    const a = this.assets.get(id)
    if (a && name.trim()) { a.name = name.trim(); this.changed() }
  }

  remove(id: string) {
    for (const [k, u] of this.companionUrls) if (k.startsWith(id + '/')) { URL.revokeObjectURL(u); this.companionUrls.delete(k) }
    const u = this.urls.get(id)
    if (u) URL.revokeObjectURL(u)
    this.urls.delete(id)
    this.assets.delete(id)
    this.changed()
  }

  clear() {
    for (const u of this.urls.values()) URL.revokeObjectURL(u)
    for (const u of this.companionUrls.values()) URL.revokeObjectURL(u)
    this.urls.clear()
    this.companionUrls.clear()
    this.assets.clear()
    this.changed()
  }

  serialize(): SerializedAsset[] {
    return this.list().map((a) => {
      const s: SerializedAsset = { id: a.id, name: a.name, kind: a.kind, mime: a.mime, ext: a.ext, data: toBase64(a.bytes) }
      if (a.files?.size) s.files = Object.fromEntries([...a.files].map(([k, v]) => [k, toBase64(v)]))
      return s
    })
  }

  load(list: SerializedAsset[] | undefined) {
    this.clear()
    for (const s of list ?? []) {
      try {
        const ext = s.ext ?? Object.entries(EXT).find(([, v]) => v[1] === s.mime)?.[0] ?? ''
        const a: Asset = { id: s.id, name: s.name, kind: s.kind, mime: s.mime, ext, bytes: fromBase64(s.data) }
        if (s.files) a.files = new Map(Object.entries(s.files).map(([k, v]) => [k, fromBase64(v)]))
        this.assets.set(s.id, a)
      } catch { /* skip corrupt */ }
    }
    this.changed()
  }

  totalBytes() {
    let n = 0
    for (const a of this.assets.values()) { n += a.bytes.length; for (const f of a.files?.values() ?? []) n += f.length }
    return n
  }

  subscribe(fn: () => void) { this.listeners.add(fn); return () => { this.listeners.delete(fn) } }
  private changed() { this.version++; for (const l of this.listeners) l() }
}

/** The assets of the currently loaded place (shared by the editor, Play mode and the player). */
export const assets = new AssetStore()

export function contentRef(a: Asset) { return ASSET_PREFIX + a.id }
