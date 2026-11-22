// Importing files as assets and placing them in the world.
import { CFrame, Vector3, enumItem } from '../engine/datatypes'
import { Instance, createInstance } from '../engine/instance'
import { BasePart } from '../engine/classes'
import { unzipSync } from 'fflate'
import { ACCEPT, Asset, AssetKind, COMPANION_EXT, assets, contentRef, extOf, isMultiFileModel, kindOfFile } from '../engine/assets'
import { loadMesh } from '../engine/render/meshes'
import { editor } from './store'
import { insertHint } from './ops'

export function pickFiles(kind?: AssetKind, multiple = true): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = multiple
    input.accept = kind ? ACCEPT[kind] : [...new Set(Object.values(ACCEPT).join(',').split(','))].join(',')
    input.onchange = () => resolve([...(input.files ?? [])])
    input.click()
  })
}

interface Entry { name: string; path: string; read: () => Promise<Uint8Array>; zip?: string }

/**
 * Import files as assets. Multi-file models (.gltf/.obj/.fbx) take the .bin/.mtl/texture files
 * imported alongside them as companions, and .zip archives are unpacked (e.g. a Sketchfab download).
 */
export async function importFiles(files: File[]): Promise<Asset[]> {
  const entries: Entry[] = []
  for (const f of files) {
    if (extOf(f.name) === 'zip') {
      try {
        const data = unzipSync(new Uint8Array(await f.arrayBuffer()))
        for (const [path, bytes] of Object.entries(data)) {
          if (path.endsWith('/') || path.startsWith('__MACOSX') || path.split('/').pop()!.startsWith('.')) continue
          entries.push({ name: path.split('/').pop()!, path, read: async () => bytes, zip: f.name.replace(/\.zip$/i, '') })
        }
      } catch (e) {
        editor.log('error', `Could not unzip "${f.name}": ${(e as Error).message}`)
      }
    } else {
      entries.push({ name: f.name, path: (f as any).webkitRelativePath || f.name, read: async () => new Uint8Array(await f.arrayBuffer()) })
    }
  }
  const models = entries.filter((e) => isMultiFileModel(e.name))
  const companions = models.length ? entries.filter((e) => !models.includes(e) && COMPANION_EXT.has(extOf(e.name))) : []
  const out: Asset[] = []
  for (const m of models) {
    try {
      const dir = m.path.includes('/') ? m.path.slice(0, m.path.lastIndexOf('/') + 1) : ''
      const map = new Map<string, Uint8Array>()
      for (const c of companions) map.set(dir && c.path.startsWith(dir) ? c.path.slice(dir.length) : c.path, await c.read())
      // a zip with one model (e.g. Sketchfab's scene.gltf) is named after the zip
      const name = m.zip && models.filter((x) => x.zip === m.zip).length === 1 ? `${m.zip}.${extOf(m.name)}` : m.name
      const a = assets.importBytes(name, await m.read(), map)
      out.push(a)
      let size = a.bytes.length
      for (const v of map.values()) size += v.length
      editor.log('system', `Imported model "${a.name}" (${formatBytes(size)}${map.size ? `, with ${map.size} companion file${map.size > 1 ? 's' : ''}` : ''})`)
    } catch (e) {
      editor.log('error', `Import of "${m.name}" failed: ${(e as Error).message}`)
    }
  }
  for (const e of entries) {
    if (models.includes(e) || companions.includes(e)) continue
    const ext = extOf(e.name)
    if (!kindOfFile(e.name)) {
      if (ext === 'bin' || ext === 'mtl') editor.log('warn', `"${e.name}" belongs to a model: import it together with the .gltf/.obj file (or as a .zip).`)
      else if (entries.length === 1 || !['txt', 'md', 'json', 'license'].includes(ext)) editor.log('warn', `Skipped "${e.name}": unsupported file type`)
      continue
    }
    try {
      const a = assets.importBytes(e.name, await e.read())
      out.push(a)
      editor.log('system', `Imported ${a.kind} "${a.name}" (${formatBytes(a.bytes.length)})`)
    } catch (err) {
      editor.log('error', `Import of "${e.name}" failed: ${(err as Error).message}`)
    }
  }
  return out
}

export interface DropTarget { part?: BasePart | null; point?: Vector3; normal?: Vector3 }

function faceFromNormal(part: BasePart, n: Vector3): string {
  const local = part.cframe.rotationOnly().inverse().vectorToWorld(n)
  const ax = Math.abs(local.x), ay = Math.abs(local.y), az = Math.abs(local.z)
  if (ax >= ay && ax >= az) return local.x > 0 ? 'Right' : 'Left'
  if (ay >= az) return local.y > 0 ? 'Top' : 'Bottom'
  return local.z > 0 ? 'Back' : 'Front'
}

/** Put an asset into the place: meshes become MeshParts, images become Decals, audio becomes Sounds. */
export async function insertAsset(asset: Asset, at: DropTarget = {}): Promise<Instance | null> {
  if (editor.playing) return null
  const ref = contentRef(asset)
  const point = at.point ?? insertHint.position
  if (asset.kind === 'mesh') {
    const mesh = await loadMesh(ref)
    let size = mesh ? new Vector3(mesh.naturalSize.x, mesh.naturalSize.y, mesh.naturalSize.z) : new Vector3(4, 4, 4)
    const max = Math.max(size.x, size.y, size.z) || 1
    // keep imported meshes at a workable scale (files use all kinds of units)
    if (max > 64 || max < 0.5) size = size.mul(8 / max)
    size = new Vector3(Math.max(size.x, 0.05), Math.max(size.y, 0.05), Math.max(size.z, 0.05))
    return editor.mutate(() => {
      const p = createInstance('MeshPart') as BasePart
      p.name = asset.name
      p.set('MeshId', ref)
      p.set('Size', size)
      p.set('Anchored', true)
      p.set('CFrame', CFrame.fromPosition(new Vector3(point.x, point.y + size.y / 2, point.z)))
      p.setParent(editor.game.workspace)
      editor.selection = [p]
      return p
    })
  }
  if (asset.kind === 'image') {
    const target = at.part ?? (editor.selection.find((s) => s instanceof BasePart) as BasePart | undefined)
    return editor.mutate(() => {
      let part = target
      if (!part) {
        part = createInstance('Part') as BasePart
        part.name = asset.name
        part.set('Size', new Vector3(6, 6, 0.4))
        part.set('Anchored', true)
        part.set('CFrame', CFrame.fromPosition(new Vector3(point.x, point.y + 3, point.z)))
        part.setParent(editor.game.workspace)
      }
      const d = createInstance('Decal')
      d.name = asset.name
      d.set('Texture', ref)
      d.set('Face', enumItem('NormalId', at.normal && at.part ? faceFromNormal(part, at.normal) : 'Front'))
      d.setParent(part)
      editor.selection = [d]
      return d
    })
  }
  return editor.mutate(() => {
    const s = createInstance('Sound')
    s.name = asset.name
    s.set('SoundId', ref)
    const parent = at.part ?? editor.selection.find((x) => x instanceof BasePart) ?? editor.game.workspace
    s.setParent(parent)
    editor.selection = [s]
    return s
  })
}

/** Count properties that reference an asset (for the delete warning). */
export function usagesOf(asset: Asset): Instance[] {
  const ref = contentRef(asset)
  const byName = 'asset://' + asset.name
  return editor.game.getDescendants().filter((d) => {
    for (const [name, def] of d.classInfo.props) {
      if (def.type === 'Content') {
        const v = d.get<string>(name)
        if (v === ref || v === byName) return true
      }
    }
    return d.isA('LuaSourceContainer') && (d.get<string>('Source') ?? '').includes(byName)
  })
}

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
