// Loads imported mesh assets (glb/gltf/obj/fbx/stl) and normalizes them to a unit cube centred on
// the origin, so a MeshPart stretches the mesh to its Size (like Roblox).
// Handles multi-file models (external .bin/.mtl/textures stored with the asset), Draco and Meshopt
// compressed glTF, and rigged (skinned) models.
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import { MTLLoader } from 'three/examples/jsm/loaders/MTLLoader.js'
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js'
import { Asset, assets, extOf } from '../assets'

export interface LoadedMesh {
  /** normalized object (unit cube); use cloneMesh() per instance */
  object: THREE.Object3D
  /** size of the mesh in its own units, before normalization */
  naturalSize: THREE.Vector3
  /** a subset of vertex positions in normalized space (for convex hull colliders) */
  hullPoints: Float32Array
  /** whether the file brought its own textured materials */
  hasTextures: boolean
  skinned: boolean
  triangles: number
}

// ---- error reporting (the editor shows these in Output) ---------------------------------------
type MeshErrorListener = (assetName: string, message: string) => void
const listeners = new Set<MeshErrorListener>()
export function onMeshError(fn: MeshErrorListener) { listeners.add(fn); return () => { listeners.delete(fn) } }
function report(name: string, message: string) {
  console.warn(`Mesh "${name}": ${message}`)
  for (const l of listeners) l(name, message)
}

const cache = new Map<string, Promise<LoadedMesh | null>>()
const ready = new Map<string, LoadedMesh | null>()

export function loadMesh(content: string): Promise<LoadedMesh | null> {
  const asset = assets.resolve(content)
  const key = asset ? asset.id : content
  let p = cache.get(key)
  if (!p) {
    p = doLoad(content, asset).catch((e) => {
      report(asset?.name ?? content, friendlyError(e, asset))
      ready.set(key, null)
      return null
    })
    cache.set(key, p)
  }
  return p
}

/** Synchronous access once loaded (physics uses this). */
export function loadedMesh(content: string): LoadedMesh | null | undefined {
  const asset = assets.resolve(content)
  return ready.get(asset ? asset.id : content)
}

/** Clone a loaded mesh for one MeshPart (skinned meshes need their skeleton rebound). */
export function cloneMesh(m: LoadedMesh): THREE.Object3D {
  return m.skinned ? SkeletonUtils.clone(m.object) : m.object.clone(true)
}

let draco: DRACOLoader | null = null
function dracoLoader() {
  if (!draco) {
    draco = new DRACOLoader()
    const base = typeof document !== 'undefined' ? new URL('draco/', document.baseURI).href : 'draco/'
    draco.setDecoderPath(base)
  }
  return draco
}

function friendlyError(e: unknown, asset: Asset | null): string {
  const msg = String((e as Error)?.message ?? e)
  if (/KTX2/i.test(msg)) return 'uses KTX2/Basis compressed textures, which aren\'t supported yet. Re-export the model with PNG/JPEG textures.'
  if (/setDRACOLoader|draco/i.test(msg)) return `Draco decoding failed (${msg}).`
  if (/Failed to (fetch|load)|404|Couldn't load|Unexpected token '<'/i.test(msg)) {
    return `a file it references is missing (${msg}). Import the model together with its .bin/.mtl/texture files (select them all), or import the model's .zip.`
  }
  if (asset?.ext === 'fbx' && /version|binary|ascii/i.test(msg)) return `this FBX version isn't supported (${msg}). Try exporting as glTF/GLB.`
  return msg
}

async function doLoad(content: string, asset: Asset | null): Promise<LoadedMesh | null> {
  const url = assets.url(content)
  if (!url) return null
  const ext = asset?.ext || extOf(content)
  const missing = new Set<string>()
  // Resolve files the model references (scene.bin, textures/wood.png, model.mtl) to the
  // companion files imported with it.
  const manager = new THREE.LoadingManager()
  manager.setURLModifier((u) => {
    // the model itself, inline data and blob URLs the loaders create for embedded images pass through
    if (u === url || /^(data:|https?:)/.test(u) || /^blob:.*\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(u)) return u
    // relative references get resolved against the model's blob URL: strip that prefix
    const ref = u.replace(/^blob:[^/]*\/\/[^/]+\//, '')
    const hit = asset ? assets.companionUrl(asset, ref) : null
    if (hit) return hit
    missing.add(ref.split('/').pop() || ref)
    return u
  })

  let root: THREE.Object3D
  if (ext === 'glb' || ext === 'gltf' || asset?.mime.includes('gltf')) {
    const loader = new GLTFLoader(manager)
    loader.setDRACOLoader(dracoLoader())
    loader.setMeshoptDecoder(MeshoptDecoder)
    const gltf = await loader.loadAsync(url)
    root = gltf.scene ?? gltf.scenes?.[0]
    if (!root) throw new Error('the file contains no scene')
  } else if (ext === 'obj') {
    const loader = new OBJLoader(manager)
    const mtlEntry = asset?.files && [...asset.files].find(([k]) => extOf(k) === 'mtl')
    if (mtlEntry) {
      const mtl = new MTLLoader(manager).parse(new TextDecoder().decode(mtlEntry[1]), '')
      mtl.preload()
      loader.setMaterials(mtl)
    }
    root = await loader.loadAsync(url)
  } else if (ext === 'stl') {
    const geo = await new STLLoader(manager).loadAsync(url)
    root = new THREE.Mesh(geo, new THREE.MeshStandardMaterial())
  } else if (ext === 'fbx') {
    root = await new FBXLoader(manager).loadAsync(url)
  } else {
    throw new Error(`unsupported model format ".${ext}"`)
  }
  if (missing.size) report(asset?.name ?? content, `references files that weren't imported: ${[...missing].join(', ')}. Import them together with the model (or as a .zip) to get its full textures.`)

  root.updateMatrixWorld(true)
  let triangles = 0
  let skinned = false
  root.traverse((o) => {
    const m = o as THREE.Mesh
    if (!m.isMesh) return
    if ((m as THREE.SkinnedMesh).isSkinnedMesh) skinned = true
    const g = m.geometry
    triangles += g.index ? g.index.count / 3 : (g.getAttribute('position')?.count ?? 0) / 3
  })
  if (!triangles) throw new Error('the file loaded but contains no mesh geometry')

  const box = new THREE.Box3().setFromObject(root, true)
  if (box.isEmpty()) box.setFromObject(root)
  const size = box.getSize(new THREE.Vector3())
  const center = box.getCenter(new THREE.Vector3())
  const safe = new THREE.Vector3(size.x || 1, size.y || 1, size.z || 1)
  const inner = new THREE.Group()
  inner.add(root)
  inner.position.copy(center).multiplyScalar(-1)
  const outer = new THREE.Group()
  outer.add(inner)
  outer.scale.set(1 / safe.x, 1 / safe.y, 1 / safe.z)
  outer.updateMatrixWorld(true)

  let hasTextures = false
  const pts: number[] = []
  const v = new THREE.Vector3()
  const budget = 4000
  const stride = Math.max(1, Math.floor(triangles * 3 / budget))
  outer.traverse((o) => {
    const m = o as THREE.Mesh
    if (!m.isMesh) return
    m.castShadow = true
    m.receiveShadow = true
    m.frustumCulled = !(m as THREE.SkinnedMesh).isSkinnedMesh
    const mats = Array.isArray(m.material) ? m.material : [m.material]
    if (mats.some((mat) => (mat as THREE.MeshStandardMaterial).map)) hasTextures = true
    const pos = m.geometry.getAttribute('position')
    if (!pos) return
    for (let i = 0; i < pos.count; i += stride) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld)
      pts.push(v.x, v.y, v.z)
    }
  })
  const result: LoadedMesh = { object: outer, naturalSize: size, hullPoints: new Float32Array(pts), hasTextures, skinned, triangles }
  ready.set(asset ? asset.id : content, result)
  return result
}

const textureCache = new Map<string, THREE.Texture>()
export function loadTexture(content: string): THREE.Texture | null {
  const url = assets.url(content)
  if (!url) return null
  let t = textureCache.get(url)
  if (!t) {
    t = new THREE.TextureLoader().load(url)
    t.colorSpace = THREE.SRGBColorSpace
    t.anisotropy = 4
    textureCache.set(url, t)
  }
  return t
}
