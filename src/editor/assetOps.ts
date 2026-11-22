// Importing files as assets and placing them in the world.
import { CFrame, Vector3, enumItem } from '../engine/datatypes'
import { Instance, createInstance } from '../engine/instance'
import { BasePart } from '../engine/classes'
import { ACCEPT, Asset, AssetKind, assets, contentRef, kindOfFile } from '../engine/assets'
import { loadMesh } from '../engine/render/meshes'
import { editor } from './store'
import { insertHint } from './ops'

export function pickFiles(kind?: AssetKind, multiple = true): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = multiple
    input.accept = kind ? ACCEPT[kind] : Object.values(ACCEPT).join(',')
    input.onchange = () => resolve([...(input.files ?? [])])
    input.click()
  })
}

export async function importFiles(files: File[]): Promise<Asset[]> {
  const out: Asset[] = []
  for (const f of files) {
    if (!kindOfFile(f.name)) { editor.log('warn', `Skipped "${f.name}": unsupported file type`); continue }
    try {
      const a = await assets.importFile(f)
      out.push(a)
      editor.log('system', `Imported ${a.kind} "${a.name}" (${formatBytes(a.bytes.length)})`)
    } catch (e) {
      editor.log('error', `Import of "${f.name}" failed: ${(e as Error).message}`)
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
