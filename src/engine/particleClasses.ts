// Properties and methods shared by ParticleEmitter (3D, inside a part) and ParticleEmitter2D (a 2D node).
// The renderers simulate and draw the particles; scripts only set properties and call Emit / Clear.
import { Color3, Vector2, Vector3, enumItem } from './datatypes'
import { Instance, PropDef, defaultFor } from './instance'

/** Requests from scripts (Emit / Clear), picked up by whichever renderer draws the emitter. */
export interface EmitterRequests { burst: number; clear: boolean }
export const requestsOf = (inst: Instance): EmitterRequests => {
  const i = inst as unknown as { particleRequests?: EmitterRequests }
  return (i.particleRequests ??= { burst: 0, clear: false })
}

export function emitterProps(dim: '2d' | '3d'): Record<string, PropDef> {
  const is2d = dim === '2d'
  const E = 'Emission', M = 'Motion', A = 'Appearance'
  return {
    Enabled: { type: 'bool', default: () => true, category: E },
    Rate: { type: 'number', default: () => 20, category: E },
    Lifetime: { type: 'number', default: () => 2, category: E },
    LifetimeVariation: { type: 'number', default: () => 0.5, category: E },
    MaxParticles: { type: 'int', default: () => 500, category: E },
    ...(is2d
      ? {
          EmissionShape: { type: 'Enum.ParticleShape2D', default: () => enumItem('ParticleShape2D', 'Point'), category: E },
          EmissionSize: { type: 'Vector2', default: () => new Vector2(16, 16), category: E },
        }
      : { EmissionShape: { type: 'Enum.ParticleShape', default: () => enumItem('ParticleShape', 'Volume'), category: E } }),
    Speed: { type: 'number', default: () => (is2d ? 120 : 5), category: M },
    SpeedVariation: { type: 'number', default: () => (is2d ? 30 : 1), category: M },
    Direction: is2d
      ? { type: 'Vector2', default: () => new Vector2(0, -1), category: M }
      : { type: 'Vector3', default: () => new Vector3(0, 1, 0), category: M },
    SpreadAngle: { type: 'number', default: () => 20, category: M },
    Acceleration: is2d ? { type: 'Vector2', category: M } : { type: 'Vector3', category: M },
    Drag: { type: 'number', category: M },
    Spin: { type: 'number', category: M },
    RandomRotation: { type: 'bool', default: () => true, category: M },
    LockedToEmitter: { type: 'bool', category: M },
    Texture: { type: 'Content', content: 'image', category: A },
    Color: { type: 'Color3', default: () => new Color3(1, 1, 1), category: A },
    ColorEnd: { type: 'Color3', default: () => new Color3(1, 1, 1), category: A },
    Size: { type: 'number', default: () => (is2d ? 8 : 1), category: A },
    SizeEnd: { type: 'number', default: () => (is2d ? 4 : 0.5), category: A },
    Transparency: { type: 'number', category: A },
    TransparencyEnd: { type: 'number', default: () => 1, category: A },
    Glow: { type: 'bool', category: A },
    ...(is2d ? { PixelArt: { type: 'bool', category: A } } : {}),
  } as Record<string, PropDef>
}

export const emitterMethods = {
  /** Shoot out `count` particles at once (works even when Enabled is off). */
  Emit: (self: Instance, count?: unknown) => {
    const n = count == null ? 16 : Number(count)
    if (Number.isFinite(n) && n > 0) requestsOf(self).burst += Math.min(5000, Math.floor(n))
  },
  /** Remove every particle that is out right now. */
  Clear: (self: Instance) => { const r = requestsOf(self); r.clear = true; r.burst = 0 },
}

/**
 * Ready-made looks for the editor (property values; 3D sizes are studs, 2D sizes are pixels).
 * Each preset only sets what it needs and resets the rest to defaults.
 */
export const PARTICLE_PRESETS: Record<string, { label: string; d3: Record<string, unknown>; d2: Record<string, unknown> }> = {
  sparkles: {
    label: 'Sparkles',
    d3: { Rate: 15, Lifetime: 1.5, Speed: 2, SpreadAngle: 180, Size: 0.5, SizeEnd: 0, Color: Color3.fromRGB(255, 240, 160), ColorEnd: Color3.fromRGB(255, 200, 80), Glow: true, Spin: 180 },
    d2: { Rate: 15, Lifetime: 1.2, Speed: 40, SpeedVariation: 20, SpreadAngle: 180, Size: 6, SizeEnd: 0, Color: Color3.fromRGB(255, 240, 160), ColorEnd: Color3.fromRGB(255, 200, 80), Glow: true, EmissionShape: ['ParticleShape2D', 'Circle'] },
  },
  fire: {
    label: 'Fire',
    d3: { Rate: 60, Lifetime: 1, LifetimeVariation: 0.3, Speed: 4, SpreadAngle: 12, Size: 1.6, SizeEnd: 0.3, Color: Color3.fromRGB(255, 190, 60), ColorEnd: Color3.fromRGB(255, 50, 10), Glow: true, Acceleration: new Vector3(0, 3, 0), EmissionShape: ['ParticleShape', 'Surface'] },
    d2: { Rate: 60, Lifetime: 0.8, LifetimeVariation: 0.25, Speed: 70, SpeedVariation: 25, SpreadAngle: 12, Size: 18, SizeEnd: 4, Color: Color3.fromRGB(255, 190, 60), ColorEnd: Color3.fromRGB(255, 50, 10), Glow: true, Acceleration: new Vector2(0, -60), EmissionShape: ['ParticleShape2D', 'Rectangle'], EmissionSize: new Vector2(16, 4) },
  },
  smoke: {
    label: 'Smoke',
    d3: { Rate: 12, Lifetime: 4, LifetimeVariation: 1, Speed: 2, SpreadAngle: 15, Size: 1.5, SizeEnd: 5, Color: Color3.fromRGB(120, 120, 125), ColorEnd: Color3.fromRGB(200, 200, 205), Transparency: 0.4, Drag: 0.3, Spin: 20 },
    d2: { Rate: 12, Lifetime: 3, LifetimeVariation: 0.8, Speed: 40, SpreadAngle: 15, Size: 14, SizeEnd: 48, Color: Color3.fromRGB(120, 120, 125), ColorEnd: Color3.fromRGB(200, 200, 205), Transparency: 0.4, Drag: 0.3, Spin: 20 },
  },
  snow: {
    label: 'Snow / dust',
    d3: { Rate: 30, Lifetime: 8, Speed: 1, SpreadAngle: 30, Direction: new Vector3(0, -1, 0), Acceleration: new Vector3(0, -0.5, 0), Size: 0.35, SizeEnd: 0.35, TransparencyEnd: 0.2 },
    d2: { Rate: 30, Lifetime: 6, Speed: 30, SpreadAngle: 30, Direction: new Vector2(0, 1), Size: 4, SizeEnd: 4, TransparencyEnd: 0.2, EmissionShape: ['ParticleShape2D', 'Rectangle'], EmissionSize: new Vector2(320, 8) },
  },
  burst: {
    label: 'Burst (Emit from a script)',
    d3: { Enabled: false, Lifetime: 0.8, LifetimeVariation: 0.2, Speed: 18, SpeedVariation: 6, SpreadAngle: 180, Drag: 3, Size: 0.7, SizeEnd: 0, Color: Color3.fromRGB(255, 230, 120), ColorEnd: Color3.fromRGB(255, 90, 40), Glow: true, EmissionShape: ['ParticleShape', 'Point'] },
    d2: { Enabled: false, Lifetime: 0.6, LifetimeVariation: 0.2, Speed: 260, SpeedVariation: 80, SpreadAngle: 180, Drag: 4, Size: 7, SizeEnd: 0, Color: Color3.fromRGB(255, 230, 120), ColorEnd: Color3.fromRGB(255, 90, 40), Glow: true },
  },
  magic: {
    label: 'Magic swirl',
    d3: { Rate: 40, Lifetime: 1.5, Speed: 3, SpreadAngle: 180, Drag: 1.5, Size: 0.6, SizeEnd: 0, Color: Color3.fromRGB(120, 200, 255), ColorEnd: Color3.fromRGB(210, 90, 255), Glow: true, Acceleration: new Vector3(0, 2, 0), LockedToEmitter: true },
    d2: { Rate: 40, Lifetime: 1.2, Speed: 60, SpreadAngle: 180, Drag: 1.5, Size: 7, SizeEnd: 0, Color: Color3.fromRGB(120, 200, 255), ColorEnd: Color3.fromRGB(210, 90, 255), Glow: true, Acceleration: new Vector2(0, -40), LockedToEmitter: true },
  },
}

/** Apply a preset: every emitter property goes back to its default, then the preset's values. */
export function applyParticlePreset(inst: Instance, key: string) {
  const p = PARTICLE_PRESETS[key]
  if (!p) return
  const dim = inst.className === 'ParticleEmitter2D' ? '2d' : '3d'
  const keep = new Set(['Texture'])
  for (const [name, def] of Object.entries(emitterProps(dim))) if (!keep.has(name)) inst.set(name, def.default ? def.default() : defaultFor(def.type))
  for (const [name, v] of Object.entries(dim === '2d' ? p.d2 : p.d3)) inst.set(name, Array.isArray(v) ? enumItem(v[0], v[1]) : v)
}

