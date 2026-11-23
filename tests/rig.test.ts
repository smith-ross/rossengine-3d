import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import '../src/engine/classes'
import { CFrame, Vector3 } from '../src/engine/datatypes'
import { Instance, createInstance } from '../src/engine/instance'
import { buildSkeleton, clipToTracks } from '../src/engine/rig'
import { applyPose, evaluate, trackTarget } from '../src/engine/animation'
import type { RigBone } from '../src/engine/render/meshes'

const q = (deg: number) => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), (deg * Math.PI) / 180).toArray()
const RIG: RigBone[] = [{
  name: 'Root', position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [2, 2, 2], children: [
    { name: 'Arm', position: [0, 2, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1], children: [{ name: 'Hand', position: [0, 2, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1], children: [] }] },
    { name: 'Arm', position: [0, -2, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1], children: [] }, // same name as its sibling
  ],
}]

describe('rigs', () => {
  it('builds a Skeleton of Bones with rest poses', () => {
    const skel = buildSkeleton(RIG)
    expect(skel.className).toBe('Skeleton')
    const root = skel.children[0]
    expect(root.className).toBe('Bone')
    expect(root.children.map((c) => c.name)).toEqual(['Arm', 'Arm'])
    const hand = root.children[0].children[0]
    expect(hand.get<CFrame>('CFrame').position).toEqual(new Vector3(0, 2, 0))
    expect(hand.get<CFrame>('Transform').position).toEqual(new Vector3(0, 0, 0)) // no offset: rest pose
    // pose properties edit Transform
    hand.set('PoseRotation', new Vector3(0, 0, 90))
    expect(hand.get<CFrame>('Transform').toOrientation().z).toBeCloseTo(90)
    expect(hand.get<Vector3>('Position')).toEqual(new Vector3(0, 2, 0))
  })

  it("turns a file's clip into Transform tracks relative to the rest pose", () => {
    const clip = new THREE.AnimationClip('Wave', 2, [
      new THREE.QuaternionKeyframeTrack('Arm.quaternion', [0, 0.5, 1, 1.5, 2], [...q(0), ...q(30), ...q(0), ...q(-30), ...q(0)]),
      new THREE.VectorKeyframeTrack('Hand.position', [0, 2], [0, 2, 0, 0, 3, 0]), // rest is (0,2,0)
      new THREE.QuaternionKeyframeTrack('Missing.quaternion', [0], [...q(0)]), // not in the rig: ignored
    ])
    const tracks = clipToTracks(clip, RIG)
    expect(tracks.map((t) => `${t.path.join('/')}.${t.prop}`)).toEqual(['Skeleton/Root/Arm.Transform', 'Skeleton/Root/Arm/Hand.Transform'])
    const arm = tracks[0]
    // the middle key (0 deg halfway between +30 and -30) is reproduced by blending, so it's dropped
    expect(arm.keys.map((k) => k.t)).toEqual([0, 0.5, 1.5, 2])
    expect((evaluate(arm, 0.5) as CFrame).toOrientation().z).toBeCloseTo(30)
    expect((evaluate(arm, 1) as CFrame).toOrientation().z).toBeCloseTo(0, 4)
    const hand = tracks[1]
    expect((evaluate(hand, 2) as CFrame).position.y).toBeCloseTo(1) // 3 - rest 2: an offset

    // applied to a MeshPart's skeleton through an AnimationPlayer root
    const part = createInstance('MeshPart')
    buildSkeleton(RIG).setParent(part)
    applyPose(part, tracks, 0.5, CFrame.identity)
    const armBone = trackTarget(part, arm) as Instance
    expect(armBone.get<CFrame>('Transform').toOrientation().z).toBeCloseTo(30)
    // the first "Arm" was animated, not its same-named sibling
    expect(armBone).toBe(part.children[0].children[0].children[0])
    expect(part.children[0].children[0].children[1].get<CFrame>('Transform').toOrientation().z).toBeCloseTo(0)
  })

  it('imports bone scale: rest Scale on the Bone, scale clips as PoseScale tracks', () => {
    const skel = buildSkeleton(RIG)
    expect(skel.children[0].get<Vector3>('Scale')).toEqual(new Vector3(2, 2, 2))
    expect(skel.children[0].get<Vector3>('PoseScale')).toEqual(new Vector3(1, 1, 1))
    const clip = new THREE.AnimationClip('Squash', 1, [
      // Hand grows to double width and back
      new THREE.VectorKeyframeTrack('Hand.scale', [0, 0.5, 1], [1, 1, 1, 2, 1, 1, 1, 1, 1]),
      // Root's scale channel never changes from its rest scale (2): nothing to animate
      new THREE.VectorKeyframeTrack('Root.scale', [0, 1], [2, 2, 2, 2, 2, 2]),
      // Arm's rotation channel stays at rest: nothing to animate either
      new THREE.QuaternionKeyframeTrack('Arm.quaternion', [0, 1], [...q(0), ...q(0)]),
    ])
    const tracks = clipToTracks(clip, RIG)
    expect(tracks.map((t) => `${t.path.join('/')}.${t.prop}`)).toEqual(['Skeleton/Root/Arm/Hand.PoseScale'])
    expect(evaluate(tracks[0], 0.25)).toEqual(new Vector3(1.5, 1, 1))
    const part = createInstance('MeshPart')
    buildSkeleton(RIG).setParent(part)
    applyPose(part, tracks, 0.5, CFrame.identity)
    expect(trackTarget(part, tracks[0])!.get<Vector3>('PoseScale')).toEqual(new Vector3(2, 1, 1))
  })
})
