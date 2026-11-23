// Visual shader steps ("recipes"): a list of plain-English steps that compiles to GLSL.
//
// A recipe is stored as JSON on a Shader/ScreenShader (the Recipe property). The editor shows it as
// sentences with inline controls; this module turns it into the shader's Source, so the engine
// only ever runs ordinary GLSL (and "Convert to code" just keeps that Source).
export type RecipeKind = '3d' | '2d' | 'screen'
export type Category = 'Image' | 'Colour' | 'Light & glow' | 'See-through' | 'Screen effects' | 'Movement'
export type ParamType = 'color' | 'percent' | 'number' | 'choice' | 'pattern' | 'bool'

export interface ParamDef {
  key: string
  type: ParamType
  default: unknown
  min?: number
  max?: number
  step?: number
  choices?: Array<[string, string]> // [value, label]
}

export interface Pattern {
  shape: PatternShape
  size: number
  speed: number
  direction: Direction
}
export type PatternShape = 'everywhere' | 'stripes' | 'waves' | 'checkers' | 'dots' | 'noise' | 'sparkles' | 'gradient' | 'edges' | 'middle'
export type Direction = 'up' | 'down' | 'left' | 'right' | 'diagonal' | 'forward'

export interface Step { id: string; type: string; on: boolean; params: Record<string, unknown> }
export interface Recipe {
  version: 1
  /** how the colour starts (objects only): the object's own look, one colour, or a two-colour pattern */
  start: { mode: 'own' | 'color' | 'pattern'; color: string; color2: string; pattern: Pattern }
  /** 3D: light the result with the sun (otherwise it's flat / unlit) */
  lit: boolean
  steps: Step[]
}

interface Ctx { kind: RecipeKind; helpers: Set<string>; transparent: boolean }
export interface StepDef {
  type: string
  category: Category
  /** short name for the step picker */
  name: string
  /** one line for beginners: what it looks like */
  description: string
  kinds: RecipeKind[]
  /** image: changes where the picture is read from (runs first); color: changes the colour; shape: moves vertices */
  stage: 'image' | 'color' | 'shape'
  /** the sentence shown on the card; {key} marks a control */
  sentence: string
  params: ParamDef[]
  glsl: (p: Record<string, any>, ctx: Ctx) => string
}

// ------------------------------------------------------------------ helpers
const PATTERN_LABELS: Record<PatternShape, string> = {
  everywhere: 'everywhere', stripes: 'stripes', waves: 'waves', checkers: 'checkers', dots: 'dots', noise: 'clouds',
  sparkles: 'sparkles', gradient: 'a fade', edges: 'the edges', middle: 'the middle',
}
export const PATTERN_SHAPES = Object.keys(PATTERN_LABELS) as PatternShape[]
export const patternLabel = (s: PatternShape) => PATTERN_LABELS[s]
/** which extra pattern controls apply to a shape */
export const patternUses = (s: PatternShape) => ({
  size: ['stripes', 'waves', 'checkers', 'dots', 'noise', 'sparkles'].includes(s),
  speed: ['stripes', 'waves', 'checkers', 'dots', 'noise', 'sparkles'].includes(s),
  direction: ['stripes', 'waves', 'checkers', 'dots', 'noise', 'gradient'].includes(s),
})
export const DIRECTIONS: Array<[Direction, string]> = [['up', 'up'], ['down', 'down'], ['left', 'left'], ['right', 'right'], ['diagonal', 'diagonally'], ['forward', 'forwards']]
export const directionsFor = (kind: RecipeKind) => DIRECTIONS.filter(([d]) => kind === '3d' || d !== 'forward')

const DIR: Record<Direction, string> = {
  up: 'vec3(0.0, 1.0, 0.0)', down: 'vec3(0.0, -1.0, 0.0)', left: 'vec3(-1.0, 0.0, 0.0)', right: 'vec3(1.0, 0.0, 0.0)',
  diagonal: 'vec3(0.7071, 0.7071, 0.0)', forward: 'vec3(0.0, 0.0, 1.0)',
}

const f = (n: unknown, d = 3) => { const v = Number(n); const s = (Number.isFinite(v) ? v : 0).toFixed(d).replace(/0+$/, '').replace(/\.$/, '.0'); return s.includes('.') ? s : s + '.0' }
const pct = (n: unknown) => f(Number(n) / 100)

/** "#ff66cc" -> linear-light vec3 (the scene's working colour space) */
export function colorGlsl(hex: unknown): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? ''))
  const n = m ? parseInt(m[1], 16) : 0xffffff
  const lin = (c: number) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4) }
  return `vec3(${f(lin((n >> 16) & 255))}, ${f(lin((n >> 8) & 255))}, ${f(lin(n & 255))})`
}

const HELPERS: Record<string, { needs?: string[]; code: string }> = {
  hash: { code: 'float rs_hash(vec3 p) {\n\tp = fract(p * 0.3183099 + 0.1);\n\tp *= 17.0;\n\treturn fract(p.x * p.y * p.z * (p.x + p.y + p.z));\n}' },
  noise: {
    needs: ['hash'],
    code: '// smooth random "clouds", roughly 0..1\nfloat rs_noise(vec3 p) {\n\tvec3 i = floor(p);\n\tvec3 f = fract(p);\n\tf = f * f * (3.0 - 2.0 * f);\n\treturn mix(\n\t\tmix(mix(rs_hash(i), rs_hash(i + vec3(1, 0, 0)), f.x), mix(rs_hash(i + vec3(0, 1, 0)), rs_hash(i + vec3(1, 1, 0)), f.x), f.y),\n\t\tmix(mix(rs_hash(i + vec3(0, 0, 1)), rs_hash(i + vec3(1, 0, 1)), f.x), mix(rs_hash(i + vec3(0, 1, 1)), rs_hash(i + vec3(1, 1, 1)), f.x), f.y),\n\t\tf.z);\n}',
  },
  luma: { code: 'float rs_luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }' },
  hue: {
    code: '// rotate the hue of a colour by an angle (radians)\nvec3 rs_hue(vec3 c, float a) {\n\tconst vec3 k = vec3(0.57735);\n\tfloat ca = cos(a);\n\treturn c * ca + cross(k, c) * sin(a) + k * dot(k, c) * (1.0 - ca);\n}',
  },
}
const use = (ctx: Ctx, ...names: string[]) => { for (const n of names) { for (const d of HELPERS[n].needs ?? []) use(ctx, d); ctx.helpers.add(n) } }

/** A 0..1 mask for a pattern (1 = "here"). */
export function patternGlsl(p: Pattern, ctx: Ctx): string {
  const size = f(Math.max(0.05, Number(p.size) || 1)), speed = f(Number(p.speed) || 0)
  const D = DIR[(ctx.kind !== '3d' && p.direction === 'forward') ? 'up' : p.direction] ?? DIR.up
  const along = `(dot(P, ${D}) / ${size} - TIME * ${speed})`
  const moving = `(P / ${size} - ${D} * TIME * ${speed})`
  const local = ctx.kind === '3d' ? 'LOCAL_POSITION' : 'vec3(UV - 0.5, 0.0)'
  switch (p.shape) {
    case 'everywhere': return '1.0'
    case 'stripes': return `smoothstep(-0.1, 0.1, sin(${along} * 6.2831853))`
    case 'waves': return `(0.5 + 0.5 * sin(${along} * 6.2831853))`
    case 'checkers': return `mod(floor(${moving}.x) + floor(${moving}.y) + floor(${moving}.z), 2.0)`
    case 'dots': return `(1.0 - smoothstep(0.22, 0.3, length(fract(${moving}) - 0.5)))`
    case 'noise': use(ctx, 'noise'); return `rs_noise(${moving})`
    case 'sparkles': use(ctx, 'hash'); return `step(0.93, rs_hash(floor(P / ${size}) + floor(TIME * (${speed} + 0.5) * 4.0)))`
    case 'gradient': return `clamp(dot(${local}, ${D}) + 0.5, 0.0, 1.0)`
    case 'edges': return ctx.kind === '3d'
      ? 'pow(1.0 - abs(dot(WORLD_NORMAL, normalize(CAMERA_POSITION - WORLD_POSITION))), 2.0)'
      : 'smoothstep(0.3, 0.5, max(abs(UV.x - 0.5), abs(UV.y - 0.5)))'
    case 'middle': return ctx.kind === '3d' ? '(1.0 - smoothstep(0.15, 0.6, length(LOCAL_POSITION)))' : '(1.0 - smoothstep(0.1, 0.5, length(UV - 0.5)))'
  }
  return '1.0'
}

export function describePattern(p: Pattern): string {
  const u = patternUses(p.shape)
  const bits: string[] = [PATTERN_LABELS[p.shape]]
  if (u.size) bits.push(`size ${p.size}`)
  if (u.speed && Number(p.speed)) bits.push(`moving ${p.direction} at speed ${p.speed}`)
  else if (u.direction && p.shape === 'gradient') bits.push(`towards the ${p.direction === 'up' ? 'top' : p.direction === 'down' ? 'bottom' : p.direction}`)
  return bits.join(', ')
}

const pattern = (shape: PatternShape, extra: Partial<Pattern> = {}): Pattern => ({ shape, size: 1, speed: 0, direction: 'up', ...extra })

// ------------------------------------------------------------------ the steps
const P = {
  color: (key: string, def: string): ParamDef => ({ key, type: 'color', default: def }),
  percent: (key: string, def: number): ParamDef => ({ key, type: 'percent', default: def, min: 0, max: 100, step: 1 }),
  num: (key: string, def: number, min: number, max: number, step = 0.1): ParamDef => ({ key, type: 'number', default: def, min, max, step }),
  pattern: (key: string, def: Pattern): ParamDef => ({ key, type: 'pattern', default: def }),
  choice: (key: string, def: string, choices: Array<[string, string]>): ParamDef => ({ key, type: 'choice', default: def, choices }),
  bool: (key: string, def: boolean): ParamDef => ({ key, type: 'bool', default: def }),
}
const ALL: RecipeKind[] = ['3d', '2d', 'screen']
const OBJECTS: RecipeKind[] = ['3d', '2d']

export const STEPS: StepDef[] = [
  // ---- image (where the picture is read from; these run before everything else)
  {
    type: 'scroll', category: 'Image', stage: 'image', kinds: OBJECTS, name: 'Slide the image',
    description: 'Moves the texture across the surface, like a conveyor belt or flowing water.',
    sentence: 'Slide the image {direction} at speed {speed}',
    params: [P.choice('direction', 'right', [['up', 'up'], ['down', 'down'], ['left', 'left'], ['right', 'right']]), P.num('speed', 1, 0, 10)],
    glsl: (p) => `uv -= ${DIR[p.direction as Direction].replace('vec3', 'vec2').replace(/, 0\.0\)$/, ')')} * TIME * ${f(p.speed * 0.25)};`,
  },
  {
    type: 'wavy', category: 'Image', stage: 'image', kinds: ALL, name: 'Wavy image',
    description: 'Ripples the picture like a heat haze or looking through water.',
    sentence: 'Make the image wavy by {amount} at speed {speed}',
    params: [P.percent('amount', 30), P.num('speed', 2, 0, 10)],
    glsl: (p) => `uv.x += sin(uv.y * 25.0 + TIME * ${f(p.speed * 2)}) * ${f(p.amount * 0.0004)};\nuv.y += cos(uv.x * 25.0 + TIME * ${f(p.speed * 2)}) * ${f(p.amount * 0.0004)};`,
  },
  {
    type: 'pixelate', category: 'Screen effects', stage: 'image', kinds: ['screen'], name: 'Pixelate',
    description: 'Turns the screen into big chunky pixels, like a retro game.',
    sentence: 'Pixelate into blocks {pixels} pixels wide',
    params: [P.num('pixels', 6, 2, 40, 1)],
    glsl: (p) => `uv = (floor(uv * RESOLUTION / ${f(p.pixels)}) + 0.5) * ${f(p.pixels)} / RESOLUTION;`,
  },
  {
    type: 'shake', category: 'Screen effects', stage: 'image', kinds: ['screen'], name: 'Shake',
    description: 'Jitters the whole screen, like an earthquake or an explosion.',
    sentence: 'Shake the screen by {amount}',
    params: [P.percent('amount', 20)],
    glsl: (p) => `uv += vec2(sin(TIME * 53.0), cos(TIME * 47.0)) * ${f(p.amount * 0.0002)};`,
  },
  // ---- colour
  {
    type: 'tint', category: 'Colour', stage: 'color', kinds: ALL, name: 'Tint',
    description: 'Washes a colour over everything.',
    sentence: 'Tint it {color} by {amount}', params: [P.color('color', '#ff66cc'), P.percent('amount', 40)],
    glsl: (p) => `color.rgb = mix(color.rgb, color.rgb * ${colorGlsl(p.color)} * 2.0, ${pct(p.amount)});`,
  },
  {
    type: 'paint', category: 'Colour', stage: 'color', kinds: ALL, name: 'Paint a pattern',
    description: 'Paints a colour in stripes, dots, checkers, clouds, a fade and more. Patterns can move.',
    sentence: 'Paint {color} in {pattern} at {amount} strength',
    params: [P.color('color', '#33ccff'), P.pattern('pattern', pattern('stripes', { size: 1, speed: 0.5 })), P.percent('amount', 100)],
    glsl: (p, ctx) => `color.rgb = mix(color.rgb, ${colorGlsl(p.color)}, ${patternGlsl(p.pattern, ctx)} * ${pct(p.amount)});`,
  },
  {
    type: 'brightness', category: 'Colour', stage: 'color', kinds: ALL, name: 'Brighter / darker',
    description: 'Makes everything lighter or darker.',
    sentence: 'Make it {way} by {amount}', params: [P.choice('way', 'brighter', [['brighter', 'brighter'], ['darker', 'darker']]), P.percent('amount', 30)],
    glsl: (p) => `color.rgb *= ${p.way === 'darker' ? f(1 - p.amount / 100) : f(1 + p.amount / 50)};`,
  },
  {
    type: 'contrast', category: 'Colour', stage: 'color', kinds: ALL, name: 'Contrast',
    description: 'Makes darks darker and lights lighter (or flattens them).',
    sentence: 'Make the contrast {way} by {amount}', params: [P.choice('way', 'stronger', [['stronger', 'stronger'], ['softer', 'softer']]), P.percent('amount', 30)],
    glsl: (p) => `color.rgb = max((color.rgb - 0.18) * ${p.way === 'softer' ? f(1 - p.amount / 150) : f(1 + p.amount / 50)} + 0.18, 0.0);`,
  },
  {
    type: 'vivid', category: 'Colour', stage: 'color', kinds: ALL, name: 'More / less colourful',
    description: 'Makes colours more vivid, or drains them towards grey.',
    sentence: 'Make the colours {way} by {amount}', params: [P.choice('way', 'more vivid', [['more vivid', 'more vivid'], ['duller', 'duller']]), P.percent('amount', 40)],
    glsl: (p, ctx) => { use(ctx, 'luma'); return `color.rgb = max(mix(vec3(rs_luma(color.rgb)), color.rgb, ${p.way === 'duller' ? f(1 - p.amount / 100) : f(1 + p.amount / 50)}), 0.0);` },
  },
  {
    type: 'blackwhite', category: 'Colour', stage: 'color', kinds: ALL, name: 'Black and white',
    description: 'Removes the colour.',
    sentence: 'Turn it black and white by {amount}', params: [P.percent('amount', 100)],
    glsl: (p, ctx) => { use(ctx, 'luma'); return `color.rgb = mix(color.rgb, vec3(rs_luma(color.rgb)), ${pct(p.amount)});` },
  },
  {
    type: 'sepia', category: 'Colour', stage: 'color', kinds: ALL, name: 'Old photo',
    description: 'Warm brown tones, like an old photograph.',
    sentence: 'Give it an old photo look by {amount}', params: [P.percent('amount', 80)],
    glsl: (p, ctx) => { use(ctx, 'luma'); return `color.rgb = mix(color.rgb, rs_luma(color.rgb) * vec3(1.2, 0.95, 0.65), ${pct(p.amount)});` },
  },
  {
    type: 'invert', category: 'Colour', stage: 'color', kinds: ALL, name: 'Invert',
    description: 'Swaps every colour for its opposite, like a photo negative.',
    sentence: 'Invert the colours by {amount}', params: [P.percent('amount', 100)],
    glsl: (p) => `color.rgb = mix(color.rgb, max(1.0 - color.rgb, 0.0), ${pct(p.amount)});`,
  },
  {
    type: 'rainbow', category: 'Colour', stage: 'color', kinds: ALL, name: 'Rainbow',
    description: 'Cycles the colours through the rainbow over time.',
    sentence: 'Cycle through the rainbow at speed {speed}', params: [P.num('speed', 1, 0, 10)],
    glsl: (p, ctx) => { use(ctx, 'hue'); return `color.rgb = max(rs_hue(color.rgb, TIME * ${f(p.speed)}), 0.0);` },
  },
  {
    type: 'cartoon', category: 'Colour', stage: 'color', kinds: ALL, name: 'Cartoon colours',
    description: 'Flattens smooth shading into a few bands, like a cartoon or comic.',
    sentence: 'Use cartoon colours with {levels} shades', params: [P.num('levels', 4, 2, 10, 1)],
    glsl: (p) => `color.rgb = floor(sqrt(color.rgb) * ${f(p.levels)} + 0.5) / ${f(p.levels)};\ncolor.rgb *= color.rgb;`,
  },
  {
    type: 'pulse', category: 'Colour', stage: 'color', kinds: ALL, name: 'Pulse',
    description: 'Gently gets brighter and darker, like breathing.',
    sentence: 'Pulse brighter and darker by {amount} at speed {speed}', params: [P.percent('amount', 40), P.num('speed', 2, 0, 10)],
    glsl: (p) => `color.rgb *= 1.0 + sin(TIME * ${f(p.speed * 2)}) * ${f(p.amount / 100)};`,
  },
  {
    type: 'flash', category: 'Colour', stage: 'color', kinds: ALL, name: 'Flash',
    description: 'Blinks a colour on and off, like getting hit in a game.',
    sentence: 'Flash {color} {times} times a second', params: [P.color('color', '#ffffff'), P.num('times', 2, 0.5, 10, 0.5)],
    glsl: (p) => `color.rgb = mix(color.rgb, ${colorGlsl(p.color)}, step(0.5, fract(TIME * ${f(p.times)})) * 0.8);`,
  },
  // ---- light & glow
  {
    type: 'glow', category: 'Light & glow', stage: 'color', kinds: ALL, name: 'Glow',
    description: 'Adds light that shines even in the dark. Use a pattern to glow only in places.',
    sentence: 'Glow {color} at strength {strength} in {pattern}',
    params: [P.color('color', '#66ccff'), P.num('strength', 1, 0, 5), P.pattern('pattern', pattern('everywhere'))],
    glsl: (p, ctx) => `glow += ${colorGlsl(p.color)} * ${f(p.strength)} * ${patternGlsl(p.pattern, ctx)};`,
  },
  {
    type: 'rim', category: 'Light & glow', stage: 'color', kinds: ['3d'], name: 'Edge glow',
    description: 'A glowing outline where the surface curves away from you, like a force field or a ghost.',
    sentence: 'Glow {color} around the edges at strength {strength}', params: [P.color('color', '#66ccff'), P.num('strength', 2, 0, 5)],
    glsl: (p) => `glow += ${colorGlsl(p.color)} * ${f(p.strength)} * pow(1.0 - abs(dot(WORLD_NORMAL, normalize(CAMERA_POSITION - WORLD_POSITION))), 3.0);`,
  },
  {
    type: 'shiny', category: 'Light & glow', stage: 'color', kinds: ['3d'], name: 'Shiny',
    description: 'Adds a bright highlight where the sun reflects, like polished plastic or metal.',
    sentence: 'Make it shiny at strength {strength}', params: [P.num('strength', 1, 0, 5)],
    glsl: (p) => `glow += SUN_COLOR * ${f(p.strength)} * pow(max(dot(reflect(-normalize(SUN_DIRECTION), WORLD_NORMAL), normalize(CAMERA_POSITION - WORLD_POSITION)), 0.0), 40.0);`,
  },
  {
    type: 'outline', category: 'Light & glow', stage: 'color', kinds: ['2d'], name: 'Outline',
    description: 'Draws a line around the shape of a sprite.',
    sentence: 'Outline the sprite in {color}, {thickness} pixels thick',
    params: [P.color('color', '#ffffff'), P.num('thickness', 1, 1, 4, 1)],
    glsl: (p) => [
      `// one image pixel, in sprite coordinates`,
      `vec2 px = ${f(p.thickness)} / (vec2(textureSize(TEXTURE, 0)) * vec2(UV_TRANSFORM[0][0], UV_TRANSFORM[1][1]));`,
      `float around = max(max(sampleTexture(uv + vec2(px.x, 0.0)).a, sampleTexture(uv - vec2(px.x, 0.0)).a), max(sampleTexture(uv + vec2(0.0, px.y)).a, sampleTexture(uv - vec2(0.0, px.y)).a));`,
      `if (HAS_TEXTURE && color.a < 0.5 && around > 0.5) color = vec4(${colorGlsl(p.color)}, 1.0);`,
    ].join('\n'),
  },
  // ---- see-through
  {
    type: 'seethrough', category: 'See-through', stage: 'color', kinds: OBJECTS, name: 'See-through',
    description: 'Makes it partly transparent, everywhere or in a pattern (a fade gives a soft edge).',
    sentence: 'Make it {amount} see-through in {pattern}', params: [P.percent('amount', 50), P.pattern('pattern', pattern('everywhere'))],
    glsl: (p, ctx) => { ctx.transparent = true; return `color.a *= 1.0 - ${pct(p.amount)} * ${patternGlsl(p.pattern, ctx)};` },
  },
  {
    type: 'holes', category: 'See-through', stage: 'color', kinds: OBJECTS, name: 'Cut holes',
    description: 'Cuts clean holes in a pattern, like a fence, a grate or Swiss cheese.',
    sentence: 'Cut holes in {pattern}', params: [P.pattern('pattern', pattern('dots', { size: 0.5 }))],
    glsl: (p, ctx) => `if (${patternGlsl(p.pattern, ctx)} > 0.5) discard;`,
  },
  {
    type: 'dissolve', category: 'See-through', stage: 'color', kinds: OBJECTS, name: 'Dissolve',
    description: 'Burns away in a cloudy pattern with a glowing edge. Can animate by itself.',
    sentence: 'Dissolve {amount} away with a glowing {color} edge, {animate}',
    params: [P.percent('amount', 40), P.color('color', '#ff8a2a'), P.choice('animate', 'still', [['still', 'staying still'], ['loop', 'going in and out'], ['once', 'disappearing once']])],
    glsl: (p, ctx) => {
      use(ctx, 'noise')
      const amount = p.animate === 'loop' ? '(0.5 - 0.5 * cos(TIME))' : p.animate === 'once' ? 'clamp(TIME * 0.25, 0.0, 1.05)' : pct(p.amount)
      const coords = ctx.kind === '3d' ? 'WORLD_POSITION * 1.5' : 'vec3(UV * 6.0, 0.0)'
      return `float burn = rs_noise(${coords});\nfloat gone = ${amount};\nif (burn < gone) discard;\nglow += ${colorGlsl(p.color)} * 3.0 * (1.0 - smoothstep(gone, gone + 0.06, burn)) * step(0.001, gone);`
    },
  },
  // ---- screen effects
  {
    type: 'vignette', category: 'Screen effects', stage: 'color', kinds: ['screen'], name: 'Dark corners',
    description: 'Darkens the edges of the screen to draw the eye to the middle.',
    sentence: 'Darken the corners by {amount}', params: [P.percent('amount', 40)],
    glsl: (p) => `color.rgb *= 1.0 - ${pct(p.amount)} * smoothstep(0.35, 0.85, distance(UV, vec2(0.5)));`,
  },
  {
    type: 'scanlines', category: 'Screen effects', stage: 'color', kinds: ['screen'], name: 'Old TV',
    description: 'Thin dark lines across the screen, like an old CRT television.',
    sentence: 'Add old TV lines at {amount} strength', params: [P.percent('amount', 30)],
    glsl: (p) => `color.rgb *= 1.0 - ${pct(p.amount)} * step(0.5, fract(gl_FragCoord.y / 3.0));`,
  },
  {
    type: 'grain', category: 'Screen effects', stage: 'color', kinds: ['screen'], name: 'Film grain',
    description: 'Flickering speckles, like old film or a security camera.',
    sentence: 'Add film grain at {amount} strength', params: [P.percent('amount', 15)],
    glsl: (p, ctx) => { use(ctx, 'hash'); return `color.rgb *= 1.0 + (rs_hash(vec3(gl_FragCoord.xy, floor(TIME * 24.0))) - 0.5) * ${f(p.amount / 50)};` },
  },
  {
    type: 'blur', category: 'Screen effects', stage: 'color', kinds: ['screen'], name: 'Blur',
    description: 'Softens the whole screen, like being out of focus or dazed.',
    sentence: 'Blur the screen by {amount}', params: [P.percent('amount', 30)],
    glsl: (p) => [
      `vec2 spread = ${f(p.amount / 25)} / RESOLUTION * 2.0;`,
      `vec3 sum = vec3(0.0);`,
      `for (int x = -2; x <= 2; x++) for (int y = -2; y <= 2; y++) sum += texture(TEXTURE, uv + vec2(x, y) * spread).rgb;`,
      `color.rgb = sum / 25.0;`,
    ].join('\n'),
  },
  {
    type: 'split', category: 'Screen effects', stage: 'color', kinds: ['screen'], name: 'Colour split',
    description: 'Pulls the red and blue apart at the edges, like a cheap camera lens or a glitch.',
    sentence: 'Split the colours apart by {amount}', params: [P.percent('amount', 30)],
    glsl: (p) => `vec2 shift = (uv - 0.5) * ${f(p.amount * 0.0005)};\ncolor.r = texture(TEXTURE, uv + shift).r;\ncolor.b = texture(TEXTURE, uv - shift).b;`,
  },
  {
    type: 'bars', category: 'Screen effects', stage: 'color', kinds: ['screen'], name: 'Cinema bars',
    description: 'Black bars at the top and bottom, like a movie.',
    sentence: 'Add cinema bars {size} of the screen tall', params: [P.percent('size', 10)],
    glsl: (p) => `if (abs(UV.y - 0.5) > 0.5 - ${pct(p.size)}) color.rgb = vec3(0.0);`,
  },
  // ---- movement (vertices)
  {
    type: 'wobble', category: 'Movement', stage: 'shape', kinds: ['3d'], name: 'Wobble',
    description: 'Ripples the surface in and out, like jelly or a blob.',
    sentence: 'Wobble the surface by {amount} at speed {speed}', params: [P.percent('amount', 20), P.num('speed', 2, 0, 10)],
    glsl: (p) => `p += NORMAL * sin(POSITION.y * 12.0 + POSITION.x * 7.0 + TIME * ${f(p.speed * 2)}) * ${f(p.amount * 0.0006)};`,
  },
  {
    type: 'flag', category: 'Movement', stage: 'shape', kinds: ['3d'], name: 'Wave like a flag',
    description: 'Waves back and forth along its length, like a flag or a banner in the wind.',
    sentence: 'Wave like a flag by {amount} at speed {speed}', params: [P.percent('amount', 30), P.num('speed', 2, 0, 10)],
    glsl: (p) => `p.z += sin(POSITION.x * 6.0 - TIME * ${f(p.speed * 2)}) * ${f(p.amount * 0.002)} * (POSITION.x + 0.5);`,
  },
  {
    type: 'sway', category: 'Movement', stage: 'shape', kinds: OBJECTS, name: 'Sway',
    description: 'Sways the top from side to side while the bottom stays put, like grass or a tree.',
    sentence: 'Sway the top by {amount} at speed {speed}', params: [P.percent('amount', 30), P.num('speed', 1.5, 0, 10)],
    glsl: (p) => `p.x += (POSITION.y + 0.5) * sin(TIME * ${f(p.speed * 2)}) * ${f(p.amount * 0.003)};`,
  },
  {
    type: 'bob', category: 'Movement', stage: 'shape', kinds: OBJECTS, name: 'Bob up and down',
    description: 'Floats up and down, like a pickup item or a boat.',
    sentence: 'Bob up and down by {amount} at speed {speed}', params: [P.percent('amount', 30), P.num('speed', 2, 0, 10)],
    glsl: (p) => `p.y += sin(TIME * ${f(p.speed * 2)}) * ${f(p.amount * 0.003)};`,
  },
  {
    type: 'breathe', category: 'Movement', stage: 'shape', kinds: OBJECTS, name: 'Grow and shrink',
    description: 'Gets bigger and smaller, like a heartbeat or a bouncing jelly.',
    sentence: 'Grow and shrink by {amount} at speed {speed}', params: [P.percent('amount', 15), P.num('speed', 2, 0, 10)],
    glsl: (p) => `p *= 1.0 + sin(TIME * ${f(p.speed * 2)}) * ${pct(p.amount)};`,
  },
  {
    type: 'spin', category: 'Movement', stage: 'shape', kinds: OBJECTS, name: 'Spin',
    description: 'Turns round and round on the spot (just the picture, not the object itself).',
    sentence: 'Spin at speed {speed}', params: [P.num('speed', 1, -10, 10)],
    glsl: (p, ctx) => {
      const a = `TIME * ${f(p.speed)}`
      return ctx.kind === '3d'
        ? `p.xz = mat2(cos(${a}), sin(${a}), -sin(${a}), cos(${a})) * p.xz;\n// note: lighting still uses the unspun normal`
        : `p.xy = mat2(cos(${a}), sin(${a}), -sin(${a}), cos(${a})) * p.xy;`
    },
  },
]
export const stepDef = (type: string) => STEPS.find((s) => s.type === type)
export const stepsFor = (kind: RecipeKind) => STEPS.filter((s) => s.kinds.includes(kind))
export const CATEGORIES: Category[] = ['Colour', 'Light & glow', 'See-through', 'Movement', 'Image', 'Screen effects']

// ------------------------------------------------------------------ recipes
let nextId = 1
export const newStepId = () => `s${Date.now().toString(36)}${(nextId++).toString(36)}`

export function newStep(type: string): Step {
  const def = stepDef(type)!
  const params: Record<string, unknown> = {}
  for (const p of def.params) params[p.key] = typeof p.default === 'object' ? { ...(p.default as object) } : p.default
  return { id: newStepId(), type, on: true, params }
}

/** A friendly starting point for a new visual shader. */
export function defaultRecipe(kind: RecipeKind): Recipe {
  const base: Recipe = { version: 1, start: { mode: 'own', color: '#ff66cc', color2: '#3355ff', pattern: pattern('stripes') }, lit: true, steps: [] }
  if (kind === '3d') {
    const paint = newStep('paint'); paint.params.color = '#33ccff'
    const rim = newStep('rim')
    base.steps = [paint, rim]
  } else if (kind === '2d') {
    base.steps = [newStep('outline'), newStep('pulse')]
  } else {
    base.steps = [newStep('vignette')]
  }
  return base
}

export function parseRecipe(json: string | undefined | null): Recipe | null {
  if (!json) return null
  try {
    const r = JSON.parse(json) as Recipe
    if (!r || !Array.isArray(r.steps)) return null
    return r
  } catch { return null }
}

/** The sentence with its values filled in (used for code comments). */
export function describeStep(step: Step): string {
  const def = stepDef(step.type)
  if (!def) return step.type
  return def.sentence.replace(/\{(\w+)\}/g, (_m, key) => {
    const pd = def.params.find((p) => p.key === key)
    const v = step.params[key]
    if (!pd) return String(v)
    switch (pd.type) {
      case 'percent': return `${v}%`
      case 'pattern': return describePattern(v as Pattern)
      case 'choice': return pd.choices?.find((c) => c[0] === v)?.[1] ?? String(v)
      default: return String(v)
    }
  })
}

export interface CompiledRecipe { source: string; transparent: boolean }

/** Turn a recipe into GLSL for a Shader (3d/2d) or ScreenShader. */
export function compileRecipe(recipe: Recipe, kind: RecipeKind): CompiledRecipe {
  const ctx: Ctx = { kind, helpers: new Set(), transparent: false }
  const steps = recipe.steps.filter((s) => s.on && stepDef(s.type)?.kinds.includes(kind))
  const section = (stage: StepDef['stage']) => steps
    .filter((s) => stepDef(s.type)!.stage === stage)
    .map((s) => `\t// ${describeStep(s)}\n` + indent(stepDef(s.type)!.glsl(s.params as any, ctx)))
    .join('\n')
  const image = section('image')
  const color = section('color')
  const shape = kind === 'screen' ? '' : section('shape')
  const coords = kind === '3d' ? 'WORLD_POSITION' : kind === '2d' ? 'vec3(WORLD_POSITION.xy / 16.0, 0.0)' : 'vec3(UV.x * RESOLUTION.x / RESOLUTION.y, UV.y, 0.0) * 8.0'

  let start: string
  if (kind === 'screen') start = '\tvec4 color = texture(TEXTURE, uv);'
  else if (recipe.start.mode === 'color') start = `\t// Start with ${recipe.start.color}\n\tvec4 color = vec4(${colorGlsl(recipe.start.color)}, COLOR.a * sampleTexture(uv).a);`
  else if (recipe.start.mode === 'pattern') start = `\t// Start with ${recipe.start.color} and ${recipe.start.color2} in ${describePattern(recipe.start.pattern)}\n\tvec4 color = vec4(mix(${colorGlsl(recipe.start.color)}, ${colorGlsl(recipe.start.color2)}, ${patternGlsl(recipe.start.pattern, ctx)}), COLOR.a * sampleTexture(uv).a);`
  else start = "\t// Start with the object's own look\n\tvec4 color = COLOR * sampleTexture(uv);"

  const lit = kind === '3d' && recipe.lit !== false
  const out: string[] = [
    '// Made with visual steps. Edit them in the step editor,',
    '// or choose "Convert to code" to change this GLSL by hand.',
    '',
  ]
  const order = ['hash', 'noise', 'luma', 'hue'].filter((h) => ctx.helpers.has(h))
  for (const h of order) out.push(HELPERS[h].code, '')
  out.push(
    'vec4 fragment() {',
    '\tvec2 uv = UV;',
    `\tvec3 P = ${coords}; // where this pixel is, for patterns`,
    '\tvec3 glow = vec3(0.0);',
  )
  if (image) out.push(image)
  out.push(start)
  if (color) out.push(color)
  out.push(lit ? '\t// Light it with the sun, then add any glow on top' : '\t// Add any glow on top')
  out.push(`\treturn vec4(${lit ? 'shade(color.rgb)' : 'color.rgb'} + glow, color.a);`, '}')
  if (shape) out.push('', 'vec3 vertex() {', '\tvec3 p = POSITION;', shape, '\treturn p;', '}')
  return { source: out.join('\n') + '\n', transparent: ctx.transparent }
}

const indent = (code: string) => code.split('\n').map((l) => '\t' + l).join('\n')
