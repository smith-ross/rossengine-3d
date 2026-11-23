import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import '../src/engine/classes'
import { createInstance } from '../src/engine/instance'
import { Vector2, Vector3 } from '../src/engine/datatypes'
import { ParticleSystem, coneDirection, readSettings, requestsOf } from '../src/engine/render/particles'
import { PARTICLE_PRESETS, applyParticlePreset } from '../src/engine/particleClasses'

const up = new THREE.Vector3(0, 1, 0)
const atOrigin = (p: THREE.Vector3, v: THREE.Vector3) => { p.set(0, 0, 0); v.copy(up) }

describe('particles', () => {
  it('both emitter classes exist with their defaults, and Emit / Clear queue requests', () => {
    const e3 = createInstance('ParticleEmitter'), e2 = createInstance('ParticleEmitter2D')
    expect(e3.get<Vector3>('Direction').y).toBe(1)
    expect(e2.get<Vector2>('Direction').y).toBe(-1) // up the screen (y points down in 2D)
    expect(e2.isA('Node2D')).toBe(true)
    e3.classInfo.methods.get('Emit')!(e3, 12)
    e3.classInfo.methods.get('Emit')!(e3) // default count
    expect(requestsOf(e3).burst).toBe(28)
    e3.classInfo.methods.get('Clear')!(e3)
    expect(requestsOf(e3)).toEqual({ burst: 0, clear: true })
  })

  it('spawns at the rate, ages particles out, and adds bursts', () => {
    const e = createInstance('ParticleEmitter')
    e.set('Rate', 10); e.set('Lifetime', 1); e.set('LifetimeVariation', 0); e.set('SpeedVariation', 0)
    const s = readSettings(e)
    const sys = new ParticleSystem(true)
    for (let f = 0; f < 30; f++) sys.step(1 / 60, s, new THREE.Vector3(), atOrigin) // half a second
    expect(sys.count).toBe(5)
    for (let f = 0; f < 120; f++) sys.step(1 / 60, s, new THREE.Vector3(), atOrigin)
    expect(sys.count).toBeGreaterThanOrEqual(9) // steady state: rate x lifetime
    expect(sys.count).toBeLessThanOrEqual(11)
    sys.step(1 / 60, s, new THREE.Vector3(), atOrigin, 25)
    expect(sys.count).toBeGreaterThanOrEqual(34)
    sys.clear()
    expect(sys.count).toBe(0)
    sys.dispose()
  })

  it('moves particles by speed, acceleration and drag, and respects MaxParticles', () => {
    const e = createInstance('ParticleEmitter')
    e.set('Enabled', false); e.set('Speed', 10); e.set('SpeedVariation', 0); e.set('Lifetime', 5); e.set('LifetimeVariation', 0)
    let s = readSettings(e)
    const sys = new ParticleSystem(true)
    sys.step(0, s, new THREE.Vector3(), atOrigin, 1)
    for (let f = 0; f < 60; f++) sys.step(1 / 60, s, new THREE.Vector3(0, -10, 0), atOrigin)
    const p = sys.particle(0)
    expect(p.pos.y).toBeGreaterThan(4.5) // 10 up, minus about 5 from the pull down, over a second
    expect(p.pos.y).toBeLessThan(5.5)
    expect(p.vel.y).toBeCloseTo(0, 5)
    // drag slows them
    e.set('Drag', 2); s = readSettings(e)
    sys.clear(); sys.step(0, s, new THREE.Vector3(), atOrigin, 1)
    for (let f = 0; f < 60; f++) sys.step(1 / 60, s, new THREE.Vector3(), atOrigin)
    expect(sys.particle(0).vel.y).toBeLessThan(10 * Math.exp(-2) + 0.01)
    // cap
    e.set('MaxParticles', 50); s = readSettings(e)
    sys.step(0, s, new THREE.Vector3(), atOrigin, 500)
    expect(sys.count).toBe(50)
    sys.dispose()
  })

  it('spreads directions inside the cone', () => {
    const d = new THREE.Vector3(1, 0, 0)
    for (let i = 0; i < 200; i++) {
      const v = coneDirection(d, 30)
      expect(v.length()).toBeCloseTo(1, 5)
      expect(v.angleTo(d)).toBeLessThanOrEqual((30 * Math.PI) / 180 + 1e-6)
    }
    expect(coneDirection(d, 0).equals(d)).toBe(true)
  })

  it('presets set both kinds of emitter up and keep the Texture', () => {
    for (const key of Object.keys(PARTICLE_PRESETS)) {
      for (const cls of ['ParticleEmitter', 'ParticleEmitter2D']) {
        const e = createInstance(cls)
        e.set('Texture', 'asset://abc')
        e.set('Rate', 999)
        applyParticlePreset(e, key)
        expect(e.get('Texture')).toBe('asset://abc')
        expect(e.get('Rate')).not.toBe(999)
        const s = readSettings(e)
        expect(s.lifetime).toBeGreaterThan(0)
      }
    }
    const e = createInstance('ParticleEmitter2D')
    applyParticlePreset(e, 'fire')
    expect(e.get<{ name: string }>('EmissionShape').name).toBe('Rectangle')
    expect(e.get<boolean>('Glow')).toBe(true)
  })
})
