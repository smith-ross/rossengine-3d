// Loads imported mesh assets (glb/gltf/obj/fbx/stl) and normalizes them to a unit cube centred on
// the origin, so a MeshPart stretches the mesh to its Size (like Roblox).
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { assets, extOf } from '../assets'

export interface LoadedMesh {
  /** normalized object (unit cube); clone it per instance */
  object: THREE.Object3D
  /** size of the mesh in its own units, before normalization */
  naturalSize: THREE.Vector3
  /** a subset of vertex positions in normalized space (for convex hull colliders) */
  hullPoints: Float32Array
  /** whether the file brought its own textured materials */
  hasTextures: boolean
}

const cache = new Map<string, Promise<LoadedMesh | null>>()

export function loadMesh(content: string): Promise<LoadedMesh | null> {
  const asset = assets.resolve(content)
  const key = asset ? asset.id : content
  let p = cache.get(key)
  if (!p) {
    p = doLoad(content).catch((e) => {
      console.warn('Mesh failed to load', content, e)
      return null
    })
    cache.set(key, p)
  }
  return p
}

/** Synchronous access once loaded (physics uses this). */
const ready = new Map<string, LoadedMesh | null>()
export function loadedMesh(content: string): LoadedMesh | null | undefined {
  const asset = assets.resolve(content)
  return ready.get(asset ? asset.id : content)
}

async function doLoad(content: string): Promise<LoadedMesh | null> {
  const url = assets.url(content)
  if (!url) return null
  const asset = assets.resolve(content)
  const mime = asset?.mime ?? ''
  const ext = extOf(content)
  let root: THREE.Object3D
  if (mime.includes('gltf') || ext === 'glb' || ext === 'gltf') {
    root = (await new GLTFLoader().loadAsync(url)).scene
  } else if (mime === 'model/obj' || ext === 'obj') {
    root = await new OBJLoader().loadAsync(url)
  } else if (mime === 'model/stl' || ext === 'stl') {
    const geo = await new STLLoader().loadAsync(url)
    root = new THREE.Mesh(geo, new THREE.MeshStandardMaterial())
  } else {
    root = await new FBXLoader().loadAsync(url)
  }
  root.updateMatrixWorld(true)
  const box = new THREE.Box3().setFromObject(root)
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
  outer.traverse((o) => {
    const m = o as THREE.Mesh
    if (!m.isMesh) return
    m.castShadow = true
    m.receiveShadow = true
    const mats = Array.isArray(m.material) ? m.material : [m.material]
    if (mats.some((mat) => (mat as THREE.MeshStandardMaterial).map)) hasTextures = true
    const pos = m.geometry.getAttribute('position')
    if (!pos) return
    const stride = Math.max(1, Math.floor(pos.count / 300))
    for (let i = 0; i < pos.count; i += stride) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld)
      pts.push(v.x, v.y, v.z)
    }
  })
  const result: LoadedMesh = { object: outer, naturalSize: size, hullPoints: new Float32Array(pts), hasTextures }
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
