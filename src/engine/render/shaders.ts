// Custom GLSL shaders: Shader (replaces an object's material) and ScreenShader (post-processing).
//
// Users write plain GLSL functions; this module wraps them with built-in inputs, turns the
// shader's attributes into uniforms, compiles through three.js, and maps compile errors back to
// the user's own line numbers.
//
//   vec4 fragment()   required: the colour of this pixel (BASE is what would normally be drawn)
//   vec3 vertex()     optional (Shader only): the vertex position in local space (POSITION)
import * as THREE from 'three'
import { Color3, Vector2, Vector3 } from '../datatypes'
import { Instance } from '../instance'
import { loadTexture } from './meshes'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import type { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'

export type ShaderKind = '3d' | '2d' | 'screen'

export { DEFAULT_SHADER_SOURCE, DEFAULT_SHADER_SOURCE_2D, DEFAULT_SCREEN_SHADER_SOURCE } from '../shaderDefaults'

/** Names users can rely on (also used for editor completions). */
export const BUILTINS: Record<ShaderKind, Array<{ name: string; type: string; doc: string }>> = {
  '3d': [
    { name: 'BASE', type: 'vec4', doc: "The object's normal colour (Color × texture), alpha from Transparency." },
    { name: 'COLOR', type: 'vec4', doc: "The part's Color and opacity." },
    { name: 'TEXTURE', type: 'sampler2D', doc: "The part's TextureID (or material texture)." },
    { name: 'HAS_TEXTURE', type: 'bool', doc: 'Whether TEXTURE is set.' },
    { name: 'UV', type: 'vec2', doc: 'Texture coordinates.' },
    { name: 'WORLD_POSITION', type: 'vec3', doc: 'Position of this pixel in the world.' },
    { name: 'WORLD_NORMAL', type: 'vec3', doc: 'Surface normal in world space.' },
    { name: 'LOCAL_POSITION', type: 'vec3', doc: 'Position in the part, -0.5..0.5 on each axis.' },
    { name: 'CAMERA_POSITION', type: 'vec3', doc: 'Camera position in the world.' },
    { name: 'SUN_DIRECTION', type: 'vec3', doc: 'Direction towards the sun.' },
    { name: 'SUN_COLOR', type: 'vec3', doc: 'Sun light colour × brightness.' },
    { name: 'AMBIENT', type: 'vec3', doc: 'Ambient light colour.' },
    { name: 'TIME', type: 'float', doc: 'Seconds since the renderer started.' },
    { name: 'RESOLUTION', type: 'vec2', doc: 'Screen size in pixels.' },
    { name: 'POSITION', type: 'vec3', doc: 'vertex(): local vertex position, -0.5..0.5.' },
    { name: 'NORMAL', type: 'vec3', doc: 'vertex(): local vertex normal.' },
    { name: 'shade', type: 'vec3 shade(vec3 albedo)', doc: 'Simple sun + ambient lighting.' },
    { name: 'sampleTexture', type: 'vec4 sampleTexture(vec2 uv)', doc: 'Sample TEXTURE (white if none).' },
  ],
  '2d': [
    { name: 'BASE', type: 'vec4', doc: "The object's normal colour (image × Color), alpha included." },
    { name: 'COLOR', type: 'vec4', doc: "The object's Color and opacity." },
    { name: 'TEXTURE', type: 'sampler2D', doc: 'The image (sprite sheet, tileset or text).' },
    { name: 'HAS_TEXTURE', type: 'bool', doc: 'Whether TEXTURE is set.' },
    { name: 'UV', type: 'vec2', doc: 'Coordinates across the sprite, 0..1 (tileset coordinates for TileMaps).' },
    { name: 'WORLD_POSITION', type: 'vec3', doc: 'Position in world pixels (y up).' },
    { name: 'TIME', type: 'float', doc: 'Seconds since the renderer started.' },
    { name: 'RESOLUTION', type: 'vec2', doc: 'Screen size in pixels.' },
    { name: 'POSITION', type: 'vec3', doc: 'vertex(): local vertex position (a unit quad for sprites).' },
    { name: 'NORMAL', type: 'vec3', doc: 'vertex(): local vertex normal.' },
    { name: 'sampleTexture', type: 'vec4 sampleTexture(vec2 uv)', doc: 'Sample TEXTURE at sprite coordinates (handles sprite-sheet frames).' },
    { name: 'shade', type: 'vec3 shade(vec3 albedo)', doc: 'No lighting in 2D: returns albedo.' },
  ],
  screen: [
    { name: 'BASE', type: 'vec4', doc: 'The rendered image at UV.' },
    { name: 'TEXTURE', type: 'sampler2D', doc: 'The rendered image (sample with texture(TEXTURE, uv)).' },
    { name: 'UV', type: 'vec2', doc: 'Screen coordinates, 0..1 from the bottom left.' },
    { name: 'TIME', type: 'float', doc: 'Seconds since the renderer started.' },
    { name: 'RESOLUTION', type: 'vec2', doc: 'Screen size in pixels.' },
  ],
}

export const isShaderInstance = (i: Instance | null | undefined): boolean => !!i && (i.className === 'Shader' || i.className === 'ScreenShader')
export const shaderKindFor = (shader: Instance): ShaderKind => {
  if (shader.className === 'ScreenShader') return 'screen'
  const p = shader.parent
  return p && /2D$|^TileMap$/.test(p.className) ? '2d' : '3d'
}

// ------------------------------------------------------------------ attributes -> uniforms
type UType = 'float' | 'bool' | 'vec2' | 'vec3' | 'sampler2D'
const RESERVED = new Set(BUILTINS['3d'].concat(BUILTINS['2d'], BUILTINS.screen).map((b) => b.name)
  .concat(['fragment', 'vertex', 'main', 'UV_TRANSFORM', 'SHADER_TIME']))

function uniformType(v: unknown): UType | null {
  if (typeof v === 'number') return 'float'
  if (typeof v === 'boolean') return 'bool'
  if (v instanceof Vector2) return 'vec2'
  if (v instanceof Vector3 || v instanceof Color3) return 'vec3'
  if (typeof v === 'string' && /^(asset|https?|data|blob):/.test(v)) return 'sampler2D'
  return null
}

/** The shader's attributes usable as uniforms: [name, glsl type]. */
export function attributeUniforms(shader: Instance): Array<[string, UType]> {
  const out: Array<[string, UType]> = []
  for (const [k, v] of shader.attributes) {
    if (!/^[A-Za-z_]\w*$/.test(k) || k.startsWith('gl_') || RESERVED.has(k)) continue
    const t = uniformType(v)
    if (t) out.push([k, t])
  }
  return out.sort((a, b) => a[0].localeCompare(b[0]))
}

function uniformValue(v: unknown): unknown {
  if (v instanceof Vector2) return new THREE.Vector2(v.x, v.y)
  if (v instanceof Vector3) return new THREE.Vector3(v.x, v.y, v.z)
  if (v instanceof Color3) return new THREE.Color().setRGB(v.r, v.g, v.b, THREE.SRGBColorSpace) // linear, like the rest of the scene
  if (typeof v === 'string') return loadTexture(v)
  return v
}

// ------------------------------------------------------------------ source assembly
/**
 * Replace the body of `<ret> name()` with a stub, keeping line count (so error lines still map).
 * Used to drop fragment() from the vertex stage and vertex() from the fragment stage.
 */
export function stubFunction(src: string, ret: string, name: string, stub: string): string {
  // search with comments blanked out (same length), so a commented-out function isn't matched
  const m = new RegExp(`\\b${ret}\\s+${name}\\s*\\(\\s*\\)\\s*\\{`).exec(maskComments(src))
  if (!m) return src
  let i = m.index + m[0].length, depth = 1
  while (i < src.length && depth > 0) {
    if (src.startsWith('//', i)) { const e = src.indexOf('\n', i); i = e < 0 ? src.length : e; continue }
    if (src.startsWith('/*', i)) { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 2; continue }
    if (src[i] === '{') depth++
    else if (src[i] === '}') depth--
    i++
  }
  const body = src.slice(m.index + m[0].length, i - 1)
  const newlines = body.split('\n').length - 1
  return src.slice(0, m.index + m[0].length) + ` ${stub} ` + '\n'.repeat(newlines) + '}' + src.slice(i)
}

export const hasFunction = (src: string, ret: string, name: string) => new RegExp(`\\b${ret}\\s+${name}\\s*\\(\\s*\\)`).test(maskComments(src))

/** Replace comment text with spaces (newlines kept), so positions still line up with the source. */
export function maskComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (c) => c.replace(/[^\n]/g, ' '))
}

const MARK = '// ross-shader:'

/** GLSL for a shader instance (or source + kind for tests/checking). `forCheck` drops three.js #includes. */
export function buildShader(source: string, kind: ShaderKind, uniforms: Array<[string, UType]>, id: number | string, forCheck = false) {
  const userUniforms = uniforms
    .filter(([n]) => !new RegExp(`uniform\\s+\\w+\\s+${n}\\b`).test(source)) // already declared by hand
    .map(([n, t]) => `uniform ${t} ${n};`).join('\n')
  const hasVertex = kind !== 'screen' && hasFunction(source, 'vec3', 'vertex')
  const inc = (s: string) => (forCheck ? '' : s)
  const common = `uniform float SHADER_TIME;\n#define TIME SHADER_TIME\nuniform vec2 RESOLUTION;\n${userUniforms}\n`

  if (kind === 'screen') {
    const vertexShader = `varying vec2 vUv;\nvoid main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }\n`
    const fragmentShader = `${common}uniform sampler2D TEXTURE;\nvarying vec2 vUv;\n#define UV vUv\nvec4 BASE;\n${MARK}${id}\n#line 1\n${source}\nvoid main() {\n\tBASE = texture2D(TEXTURE, vUv);\n\tgl_FragColor = fragment();\n}\n`
    return { vertexShader, fragmentShader, hasVertex: false }
  }

  const objCommon = `${common}uniform vec4 COLOR;\nuniform sampler2D TEXTURE;\nuniform bool HAS_TEXTURE;\nuniform mat3 UV_TRANSFORM;
uniform vec3 SUN_DIRECTION;\nuniform vec3 SUN_COLOR;\nuniform vec3 AMBIENT;
varying vec2 vUv;\nvarying vec3 vWorldPosition;\nvarying vec3 vWorldNormal;\nvarying vec3 vLocalPosition;
#define UV vUv\n#define WORLD_POSITION vWorldPosition\n#define WORLD_NORMAL normalize(vWorldNormal)\n#define LOCAL_POSITION vLocalPosition\n#define CAMERA_POSITION cameraPosition
vec4 sampleTexture(vec2 uv) { return HAS_TEXTURE ? texture2D(TEXTURE, (UV_TRANSFORM * vec3(uv, 1.0)).xy) : vec4(1.0); }
vec3 shade(vec3 albedo) {\n${kind === '3d' ? '\tfloat d = max(dot(normalize(vWorldNormal), normalize(SUN_DIRECTION)), 0.0);\n\treturn albedo * (AMBIENT + SUN_COLOR * d);' : '\treturn albedo;'}\n}
vec4 BASE;\n`

  // vertex stage: only includes the user's code when it defines vertex()
  const vsUser = hasVertex ? `${MARK}${id}\n#line 1\n${stubFunction(source, 'vec4', 'fragment', 'return vec4(0.0);')}\n` : ''
  const vertexShader = `${objCommon}vec3 POSITION;\nvec3 NORMAL;\n${vsUser}void main() {
\tPOSITION = position;\n\tNORMAL = normal;
\tvec3 p = ${hasVertex ? 'vertex()' : 'position'};
\tvUv = uv;\n\tvLocalPosition = p;
\tvec4 wp = modelMatrix * vec4(p, 1.0);\n\tvWorldPosition = wp.xyz;
\tvWorldNormal = inverse(transpose(mat3(modelMatrix))) * normal;
\tgl_Position = projectionMatrix * viewMatrix * wp;\n}\n`

  const fsUser = hasVertex ? stubFunction(source, 'vec3', 'vertex', 'return vec3(0.0);') : source
  const fragmentShader = `${objCommon}vec3 POSITION;\nvec3 NORMAL;\n${MARK}${id}\n#line 1\n${fsUser}\nvoid main() {
\tBASE = COLOR * sampleTexture(vUv);
\tgl_FragColor = fragment();
${inc('\t#include <tonemapping_fragment>\n\t#include <colorspace_fragment>')}
}\n`
  return { vertexShader, fragmentShader, hasVertex }
}

// ------------------------------------------------------------------ materials
/** Live uniforms every shader material gets (values are refreshed each frame by the renderer). */
export function baseUniforms(kind: ShaderKind): Record<string, THREE.IUniform> {
  const u: Record<string, THREE.IUniform> = { SHADER_TIME: { value: 0 }, RESOLUTION: { value: new THREE.Vector2(1, 1) } }
  if (kind === 'screen') { u.TEXTURE = { value: null }; return u }
  Object.assign(u, {
    COLOR: { value: new THREE.Vector4(1, 1, 1, 1) },
    TEXTURE: { value: null },
    HAS_TEXTURE: { value: false },
    UV_TRANSFORM: { value: new THREE.Matrix3() },
    SUN_DIRECTION: { value: new THREE.Vector3(0.4, 1, 0.3).normalize() },
    SUN_COLOR: { value: new THREE.Vector3(1, 1, 1) },
    AMBIENT: { value: new THREE.Vector3(0.35, 0.35, 0.38) },
  })
  return u
}

export interface ShaderMat {
  shader: Instance
  material: THREE.ShaderMaterial
  key: string
  uniforms: Array<[string, UType]>
}

const registry = new Map<string, Instance>()

/** Build-or-reuse a ShaderMaterial for a Shader/ScreenShader instance. Returns null if it failed to compile. */
export function shaderMaterial(shader: Instance, kind: ShaderKind, prev?: ShaderMat | null): ShaderMat | null {
  const source = shader.get<string>('Source') ?? ''
  const uniforms = attributeUniforms(shader)
  const key = materialKey(shader, kind)
  if (failed.get(shader) === key) { prev?.material.dispose(); return null }
  if (prev && prev.key === key) return prev
  prev?.material.dispose()
  const { vertexShader, fragmentShader } = buildShader(source, kind, uniforms, shader.id)
  registry.set(String(shader.id), shader)
  const material = new THREE.ShaderMaterial({
    vertexShader, fragmentShader,
    uniforms: { ...baseUniforms(kind), ...Object.fromEntries(uniforms.map(([n]) => [n, { value: null }])) },
    // 2D draws in order without depth; 3D transparency is set per frame by the renderer
    transparent: kind === '2d',
    depthWrite: kind !== '2d',
    depthTest: kind !== '2d',
    side: kind === '2d' ? THREE.DoubleSide : THREE.FrontSide,
  })
  material.userData.shaderKey = key
  const sm: ShaderMat = { shader, material, key, uniforms }
  updateShaderUniforms(sm)
  return sm
}

/** Copy the shader's attributes into its uniforms (cheap; called every frame). */
export function updateShaderUniforms(sm: ShaderMat, time = clock()) {
  const u = sm.material.uniforms
  u.SHADER_TIME.value = time
  for (const [name] of sm.uniforms) u[name].value = uniformValue(sm.shader.attributes.get(name))
}

const t0 = performance.now()
export const clock = () => (performance.now() - t0) / 1000

// ------------------------------------------------------------------ compile errors
export interface ShaderError { shader: Instance; line: number | null; message: string }
const failed = new Map<Instance, string>()
const errorListeners = new Set<(errs: ShaderError[]) => void>()
const failureListeners = new Set<(shader: Instance) => void>()

/** Compile errors (editor Output). */
export function onShaderErrors(fn: (errs: ShaderError[]) => void) { errorListeners.add(fn); return () => errorListeners.delete(fn) }
/** A shader failed; renderers fall back to the normal material. */
export function onShaderFailed(fn: (shader: Instance) => void) { failureListeners.add(fn); return () => failureListeners.delete(fn) }
export const shaderFailed = (shader: Instance) => failed.has(shader)

/** "ERROR: 0:12: 'x' : undeclared identifier" -> { line: 12, message } */
export function parseInfoLog(log: string): Array<{ line: number | null; message: string }> {
  const out: Array<{ line: number | null; message: string }> = []
  for (const raw of log.split('\n')) {
    const l = raw.trim()
    if (!l) continue
    const m = /^(?:ERROR|WARNING):\s*\d+:(\d+):\s*(.*)$/.exec(l)
    if (m) out.push({ line: Number(m[1]), message: m[2].replace(/\s*:\s*$/, '') })
    else if (/^(ERROR|WARNING)/.test(l)) out.push({ line: null, message: l.replace(/^(ERROR|WARNING):\s*/, '') })
  }
  return out
}

/** Install on a WebGLRenderer: routes custom-shader compile errors to listeners. */
export function installShaderErrorHandler(renderer: THREE.WebGLRenderer) {
  renderer.debug.onShaderError = (gl, program, vs, fs) => {
    const vsSrc = gl.getShaderSource(vs) ?? '', fsSrc = gl.getShaderSource(fs) ?? ''
    const id = (new RegExp(`${MARK}(\\S+)`).exec(fsSrc) ?? new RegExp(`${MARK}(\\S+)`).exec(vsSrc))?.[1]
    const shader = id ? registry.get(id) : undefined
    const logs = [gl.getShaderInfoLog(vs) ?? '', gl.getShaderInfoLog(fs) ?? ''].join('\n')
    if (!shader) {
      console.error('Shader error:', logs || gl.getProgramInfoLog(program))
      return
    }
    reportFailure(shader, parseInfoLog(logs || gl.getProgramInfoLog(program) || 'link error'))
  }
}

/** Identifies one compiled version of a shader: its kind, uniform declarations and source. */
function materialKey(shader: Instance, kind: ShaderKind) {
  return `${kind}|${attributeUniforms(shader).map((u) => u.join(':')).join(',')}|${shader.get<string>('Source') ?? ''}`
}

function reportFailure(shader: Instance, errs: Array<{ line: number | null; message: string }>) {
  const key = materialKey(shader, shaderKindFor(shader))
  if (failed.get(shader) === key) return // already reported (e.g. by the other renderer)
  failed.set(shader, key)
  for (const fn of errorListeners) fn(errs.length ? errs.map((e) => ({ shader, ...e })) : [{ shader, line: null, message: 'failed to compile' }])
  for (const fn of failureListeners) fn(shader)
}

/** Forget a failure (source edited): the next material build tries again. */
export function clearShaderFailure(shader: Instance) { failed.delete(shader) }

// ------------------------------------------------------------------ editor check (live squiggles)
let checkGl: WebGL2RenderingContext | null | undefined
const CHECK_PREFIX_VS = `#version 300 es
precision highp float;\nprecision highp int;
#define attribute in\n#define varying out\n#define texture2D texture
uniform mat4 modelMatrix;\nuniform mat4 modelViewMatrix;\nuniform mat4 projectionMatrix;\nuniform mat4 viewMatrix;\nuniform mat3 normalMatrix;\nuniform vec3 cameraPosition;
in vec3 position;\nin vec3 normal;\nin vec2 uv;\n`
const CHECK_PREFIX_FS = `#version 300 es
precision highp float;\nprecision highp int;
#define varying in\nlayout(location = 0) out highp vec4 pc_fragColor;\n#define gl_FragColor pc_fragColor\n#define texture2D texture
uniform mat4 viewMatrix;\nuniform vec3 cameraPosition;\n`

/** Compile a shader's GLSL off-screen and return its errors (user line numbers). null if WebGL2 is unavailable. */
export function checkShader(source: string, kind: ShaderKind, uniforms: Array<[string, UType]> = []): Array<{ line: number | null; message: string }> | null {
  if (checkGl === undefined) {
    try { checkGl = document.createElement('canvas').getContext('webgl2') } catch { checkGl = null }
  }
  const gl = checkGl
  if (!gl) return null
  const { vertexShader, fragmentShader, hasVertex } = buildShader(source, kind, uniforms, 'check', true)
  const errs: Array<{ line: number | null; message: string }> = []
  const compile = (type: number, src: string, userCode: boolean) => {
    const s = gl.createShader(type)!
    gl.shaderSource(s, src)
    gl.compileShader(s)
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS) && userCode) errs.push(...parseInfoLog(gl.getShaderInfoLog(s) ?? ''))
    gl.deleteShader(s)
  }
  compile(gl.FRAGMENT_SHADER, CHECK_PREFIX_FS + fragmentShader, true)
  if (hasVertex || kind === 'screen') compile(gl.VERTEX_SHADER, CHECK_PREFIX_VS + vertexShader, kind !== 'screen')
  // de-duplicate (the same error can appear in both stages)
  const seen = new Set<string>()
  return errs.filter((e) => { const k = `${e.line}|${e.message}`; if (seen.has(k)) return false; seen.add(k); return true })
}

// ------------------------------------------------------------------ post-processing
/** Post-processing chain: scene -> each ScreenShader pass -> tone mapping + sRGB output. */
export function makeComposer(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, passes: ShaderPass[], container: HTMLElement) {
  const size = renderer.getDrawingBufferSize(new THREE.Vector2())
  const target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 4 })
  const composer = new EffectComposer(renderer, target)
  composer.addPass(new RenderPass(scene, camera))
  for (const p of passes) composer.addPass(p)
  composer.addPass(new OutputPass())
  composer.setPixelRatio(renderer.getPixelRatio())
  composer.setSize(container.clientWidth || 1, container.clientHeight || 1)
  return composer
}

/** Point a ShaderPass at a rebuilt material (after the user edits the shader). */
export function setPassMaterial(pass: ShaderPass, material: THREE.ShaderMaterial) {
  pass.material.dispose()
  pass.material = material
  pass.uniforms = material.uniforms
  ;(pass as unknown as { fsQuad: { material: THREE.Material } }).fsQuad.material = material
}
