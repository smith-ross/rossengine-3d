// Rigs from imported models: Skeleton/Bone instances, and the model's own animation clips turned
// into Animations (bone Transform tracks) for an AnimationPlayer.
import * as THREE from 'three'
import { CFrame } from './datatypes'
import { Instance, createInstance } from './instance'
import type { RigBone } from './render/meshes'
import { Track, encode } from './animation'

const cframeOf = (pos: ArrayLike<number>, quat: ArrayLike<number>) =>
  CFrame.fromPositionQuaternion(new THREE.Vector3(pos[0], pos[1], pos[2]), new THREE.Quaternion(quat[0], quat[1], quat[2], quat[3]))

/** A Skeleton with one Bone per bone of the rig (rest poses relative to the parent bone). */
export function buildSkeleton(rig: RigBone[]): Instance {
  const skel = createInstance('Skeleton')
  skel.name = 'Skeleton'
  const add = (b: RigBone, parent: Instance) => {
    const bone = createInstance('Bone')
    bone.name = b.name
    bone.set('CFrame', cframeOf(b.position, b.quaternion))
    bone.setParent(parent)
    for (const c of b.children) add(c, bone)
  }
  for (const r of rig) add(r, skel)
  return skel
}

interface BoneRef { rig: RigBone; path: string[]; idx: number[] }

/** Every bone with its path below the MeshPart (["Skeleton", ...names]) and same-name sibling indices. */
function bonePaths(rig: RigBone[]): Map<string, BoneRef> {
  const out = new Map<string, BoneRef>()
  const walk = (list: RigBone[], path: string[], idx: number[]) => {
    const seen = new Map<string, number>()
    for (const b of list) {
      const n = seen.get(b.name) ?? 0
      seen.set(b.name, n + 1)
      const ref = { rig: b, path: [...path, b.name], idx: [...idx, n] }
      if (!out.has(b.name)) out.set(b.name, ref) // clips address bones by name
      walk(b.children, ref.path, ref.idx)
    }
  }
  walk(rig, ['Skeleton'], [0])
  return out
}

/** Drop keys a straight blend between their neighbours would reproduce anyway. */
function simplify(times: number[], values: CFrame[]): number[] {
  if (values.length <= 2) return times.map((_t, i) => i)
  const keep = [0]
  for (let i = 1; i < values.length - 1; i++) {
    const a = values[keep[keep.length - 1]], b = values[i + 1], v = values[i]
    const t0 = times[keep[keep.length - 1]], t1 = times[i + 1]
    const u = (times[i] - t0) / Math.max(1e-6, t1 - t0)
    const guess = a.Lerp(b, u)
    const dp = guess.position.sub(v.position).magnitude
    const dq = Math.abs(guess.toQuaternion().dot(v.toQuaternion()))
    if (dp > 1e-4 || dq < 1 - 1e-6) keep.push(i)
  }
  keep.push(values.length - 1)
  return keep
}

/** A file's animation clip as Animation tracks on the Skeleton's bones (Transform = offset from rest). */
export function clipToTracks(clip: THREE.AnimationClip, rig: RigBone[]): Track[] {
  const bones = bonePaths(rig)
  const sanitized = new Map([...bones].map(([name, ref]) => [THREE.PropertyBinding.sanitizeNodeName(name), ref]))
  const byBone = new Map<BoneRef, { pos?: THREE.KeyframeTrack; rot?: THREE.KeyframeTrack }>()
  for (const tr of clip.tracks) {
    const parsed = THREE.PropertyBinding.parseTrackName(tr.name)
    const ref = bones.get(parsed.nodeName) ?? sanitized.get(parsed.nodeName)
    if (!ref) continue
    const e = byBone.get(ref) ?? {}
    if (parsed.propertyName === 'position') e.pos = tr
    else if (parsed.propertyName === 'quaternion') e.rot = tr
    byBone.set(ref, e)
  }
  const tracks: Track[] = []
  for (const [ref, { pos, rot }] of byBone) {
    if (!pos && !rot) continue
    const rest = cframeOf(ref.rig.position, ref.rig.quaternion)
    const restInv = rest.inverse()
    const times = [...new Set([...(pos?.times ?? []), ...(rot?.times ?? [])])].sort((a, b) => a - b)
    // createInterpolant is set on each track by three.js (not in its type definitions); it slerps quaternions
    const interp = (tr?: THREE.KeyframeTrack) => (tr as unknown as { createInterpolant?: () => THREE.Interpolant } | undefined)?.createInterpolant?.()
    const pi = interp(pos), ri = interp(rot)
    const values = times.map((t) => {
      const p: ArrayLike<number> = pi ? Array.from(pi.evaluate(t) as ArrayLike<number>) : ref.rig.position
      const q: ArrayLike<number> = ri ? Array.from(ri.evaluate(t) as ArrayLike<number>) : ref.rig.quaternion
      return restInv.mul(cframeOf(p, q))
    })
    const keep = simplify(times, values)
    const track: Track = { path: ref.path, prop: 'Transform', keys: keep.map((i) => ({ t: +times[i].toFixed(4), v: encode(values[i]), ease: 'Linear', dir: 'InOut' })) }
    if (ref.idx.some((n) => n > 0)) track.idx = ref.idx
    tracks.push(track)
  }
  return tracks
}
