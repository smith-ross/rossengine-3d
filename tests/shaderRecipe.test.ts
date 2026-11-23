import { describe, it, expect } from 'vitest'
import { STEPS, colorGlsl, compileRecipe, defaultRecipe, describeStep, newStep, parseRecipe, stepsFor } from '../src/engine/shaderRecipe'
import { buildShader } from '../src/engine/render/shaders'

describe('visual shader steps', () => {
  it('compiles every step for every kind it supports, with the sentence as a comment', () => {
    for (const kind of ['3d', '2d', 'screen'] as const) {
      for (const def of stepsFor(kind)) {
        const r = defaultRecipe(kind)
        const step = newStep(def.type)
        r.steps = [step]
        const { source } = compileRecipe(r, kind)
        expect(source, `${kind}/${def.type}`).toContain('vec4 fragment() {')
        expect(source).toContain(`// ${describeStep(step)}`)
        // and it wraps into a full shader without throwing
        expect(() => buildShader(source, kind, [], 'test')).not.toThrow()
        if (def.stage === 'shape') expect(source).toContain('vec3 vertex() {')
      }
    }
    // every step is available somewhere, and names/descriptions are filled in for the picker
    for (const def of STEPS) { expect(def.kinds.length).toBeGreaterThan(0); expect(def.name && def.description).toBeTruthy() }
  })

  it('reads like the sentences on the cards', () => {
    const paint = newStep('paint')
    paint.params.color = '#ff0000'
    paint.params.pattern = { shape: 'stripes', size: 2, speed: 1, direction: 'up' }
    paint.params.amount = 50
    expect(describeStep(paint)).toBe('Paint #ff0000 in stripes, size 2, moving up at speed 1 at 50% strength')
    const dissolve = newStep('dissolve')
    dissolve.params.animate = 'loop'
    expect(describeStep(dissolve)).toContain('going in and out')
  })

  it('runs image steps before the colour is read, whatever their position', () => {
    const r = defaultRecipe('2d')
    r.steps = [newStep('tint'), newStep('scroll')]
    const src = compileRecipe(r, '2d').source
    expect(src.indexOf('uv -=')).toBeLessThan(src.indexOf('vec4 color ='))
    expect(src.indexOf('vec4 color =')).toBeLessThan(src.indexOf('Tint it'))
  })

  it('skips steps that are turned off and marks see-through recipes as transparent', () => {
    const r = defaultRecipe('3d')
    r.steps = [newStep('seethrough')]
    expect(compileRecipe(r, '3d').transparent).toBe(true)
    r.steps[0].on = false
    const off = compileRecipe(r, '3d')
    expect(off.transparent).toBe(false)
    expect(off.source).not.toContain('see-through')
  })

  it('lights 3D shaders with the sun unless turned off', () => {
    const r = defaultRecipe('3d')
    expect(compileRecipe(r, '3d').source).toContain('shade(color.rgb)')
    r.lit = false
    expect(compileRecipe(r, '3d').source).not.toContain('shade(')
    expect(compileRecipe(defaultRecipe('2d'), '2d').source).not.toContain('shade(')
  })

  it('only includes the helper functions a recipe uses', () => {
    const r = defaultRecipe('3d')
    r.steps = [newStep('tint')]
    expect(compileRecipe(r, '3d').source).not.toContain('rs_noise')
    r.steps = [newStep('dissolve')]
    const src = compileRecipe(r, '3d').source
    expect(src).toContain('float rs_noise(vec3 p)')
    expect(src).toContain('float rs_hash(vec3 p)') // pulled in by rs_noise
  })

  it('converts colours to linear light', () => {
    expect(colorGlsl('#ffffff')).toBe('vec3(1.0, 1.0, 1.0)')
    expect(colorGlsl('#000000')).toBe('vec3(0.0, 0.0, 0.0)')
    expect(colorGlsl('#808080')).toBe('vec3(0.216, 0.216, 0.216)')
  })

  it('round-trips through JSON and ignores bad data', () => {
    const r = defaultRecipe('screen')
    expect(parseRecipe(JSON.stringify(r))).toEqual(r)
    expect(parseRecipe('')).toBe(null)
    expect(parseRecipe('{oops')).toBe(null)
    // unknown step types (e.g. from a newer version) are left out rather than breaking the shader
    r.steps.push({ id: 'x', type: 'from-the-future', on: true, params: {} })
    expect(compileRecipe(r, 'screen').source).not.toContain('from-the-future')
  })
})
