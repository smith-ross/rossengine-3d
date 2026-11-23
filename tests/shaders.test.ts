import { describe, it, expect } from 'vitest'
import '../src/engine/classes'
import { createInstance } from '../src/engine/instance'
import { Color3, Vector2 } from '../src/engine/datatypes'
import { attributeUniforms, buildShader, hasFunction, parseInfoLog, shaderKindFor, stubFunction } from '../src/engine/render/shaders'

describe('custom shaders', () => {
  it('stubs a function body without changing line numbers', () => {
    const src = 'float helper() { return 1.0; }\nvec4 fragment() {\n\tvec3 c = vec3(1.0); // { not a brace }\n\t/* } */\n\treturn vec4(c, 1.0);\n}\nvec3 vertex() {\n\treturn POSITION;\n}\n'
    const out = stubFunction(src, 'vec4', 'fragment', 'return vec4(0.0);')
    expect(out.split('\n').length).toBe(src.split('\n').length)
    expect(out).toContain('vec4 fragment() { return vec4(0.0); ')
    expect(out).not.toContain('vec3 c = vec3(1.0)')
    expect(out).toContain('float helper() { return 1.0; }')
    expect(out).toContain('vec3 vertex() {\n\treturn POSITION;\n}')
    // the vertex function's line is unchanged
    expect(out.split('\n').indexOf('vec3 vertex() {')).toBe(src.split('\n').indexOf('vec3 vertex() {'))
  })

  it("puts the user's code right after #line 1 so compile errors use their line numbers", () => {
    const src = 'vec4 fragment() {\n\treturn BASE;\n}\n'
    for (const kind of ['3d', '2d', 'screen'] as const) {
      const { fragmentShader } = buildShader(src, kind, [], 7)
      const lines = fragmentShader.split('\n')
      const at = lines.indexOf('#line 1')
      expect(at).toBeGreaterThan(0)
      expect(lines[at - 1]).toBe('// ross-shader:7')
      expect(lines.slice(at + 1, at + 4).join('\n')).toBe(src.trimEnd())
    }
  })

  it('only compiles user code into the vertex stage when vertex() exists', () => {
    const plain = buildShader('vec4 fragment() { return BASE; }', '3d', [], 1)
    expect(plain.hasVertex).toBe(false)
    expect(plain.vertexShader).not.toContain('#line 1')
    const withVertex = buildShader('vec4 fragment() { return BASE * dFdx(1.0); }\nvec3 vertex() { return POSITION * 2.0; }', '3d', [], 1)
    expect(withVertex.hasVertex).toBe(true)
    expect(withVertex.vertexShader).toContain('vec3 p = vertex();')
    expect(withVertex.vertexShader).not.toContain('dFdx') // fragment() stubbed out of the vertex stage
    expect(withVertex.fragmentShader).not.toContain('POSITION * 2.0') // and vertex() out of the fragment stage
    expect(hasFunction('vec3  vertex ( ) {', 'vec3', 'vertex')).toBe(true)
    // commented-out functions don't count (the starter source has one)
    expect(hasFunction('// vec3 vertex() {\n/* vec3 vertex() { */', 'vec3', 'vertex')).toBe(false)
    expect(stubFunction('// vec4 fragment() { x }\nvec4 fragment() {\n\ty;\n}', 'vec4', 'fragment', 'S')).toBe('// vec4 fragment() { x }\nvec4 fragment() { S \n\n}')
  })

  it('turns attributes into uniforms', () => {
    const sh = createInstance('Shader')
    sh.attributes.set('Speed', 2)
    sh.attributes.set('Tint', new Color3(1, 0, 0))
    sh.attributes.set('Offset', new Vector2(1, 2))
    sh.attributes.set('On', true)
    sh.attributes.set('Noise', 'asset://noise')
    sh.attributes.set('Label', 'hello') // plain strings aren't uniforms
    sh.attributes.set('TIME', 5) // built-in names are reserved
    sh.attributes.set('bad name', 1)
    expect(attributeUniforms(sh)).toEqual([['Noise', 'sampler2D'], ['Offset', 'vec2'], ['On', 'bool'], ['Speed', 'float'], ['Tint', 'vec3']])
    const { fragmentShader } = buildShader('uniform float Speed;\nvec4 fragment() { return BASE * Speed; }', '3d', attributeUniforms(sh), 1)
    expect(fragmentShader).toContain('uniform vec3 Tint;')
    expect(fragmentShader.match(/uniform float Speed;/g)?.length).toBe(1) // declared by hand: not declared twice
  })

  it('parses WebGL info logs', () => {
    const log = "ERROR: 0:3: 'foo' : undeclared identifier\nERROR: 0:3: '=' : dimension mismatch\nERROR: 2 compilation errors.  No code generated.\n"
    expect(parseInfoLog(log)).toEqual([
      { line: 3, message: "'foo' : undeclared identifier" },
      { line: 3, message: "'=' : dimension mismatch" },
      { line: null, message: '2 compilation errors.  No code generated.' },
    ])
  })

  it('picks the shader kind from where it is', () => {
    const part = createInstance('Part'), sprite = createInstance('Sprite2D'), map = createInstance('TileMap')
    const a = createInstance('Shader'), b = createInstance('Shader'), c = createInstance('Shader'), d = createInstance('ScreenShader')
    a.setParent(part); b.setParent(sprite); c.setParent(map)
    expect([shaderKindFor(a), shaderKindFor(b), shaderKindFor(c), shaderKindFor(d)]).toEqual(['3d', '2d', '2d', 'screen'])
  })
})
