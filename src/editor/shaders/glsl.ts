// GLSL in Monaco: highlighting, completions for RossEngine's shader built-ins, hover docs.
import * as monaco from '../luau/monacoCore'
import { BUILTINS, ShaderKind } from '../../engine/render/shaders'

const KEYWORDS = [
  'const', 'uniform', 'in', 'out', 'inout', 'varying', 'attribute', 'if', 'else', 'for', 'while', 'do', 'break', 'continue',
  'return', 'discard', 'struct', 'true', 'false', 'highp', 'mediump', 'lowp', 'precision', 'void', '#define', '#if', '#ifdef',
  '#ifndef', '#else', '#endif',
]
const TYPES = [
  'float', 'int', 'uint', 'bool', 'vec2', 'vec3', 'vec4', 'ivec2', 'ivec3', 'ivec4', 'bvec2', 'bvec3', 'bvec4',
  'mat2', 'mat3', 'mat4', 'sampler2D',
]
/** name -> signature (shown in completions and hovers) */
const FUNCTIONS: Record<string, string> = {
  sin: 'genType sin(genType angle)', cos: 'genType cos(genType angle)', tan: 'genType tan(genType angle)',
  asin: 'genType asin(genType x)', acos: 'genType acos(genType x)', atan: 'genType atan(genType y, genType x)',
  pow: 'genType pow(genType x, genType y)', exp: 'genType exp(genType x)', log: 'genType log(genType x)',
  exp2: 'genType exp2(genType x)', log2: 'genType log2(genType x)', sqrt: 'genType sqrt(genType x)',
  inversesqrt: 'genType inversesqrt(genType x)', abs: 'genType abs(genType x)', sign: 'genType sign(genType x)',
  floor: 'genType floor(genType x)', ceil: 'genType ceil(genType x)', fract: 'genType fract(genType x)',
  round: 'genType round(genType x)', mod: 'genType mod(genType x, genType y)', min: 'genType min(genType x, genType y)',
  max: 'genType max(genType x, genType y)', clamp: 'genType clamp(genType x, genType lo, genType hi)',
  mix: 'genType mix(genType a, genType b, genType t)', step: 'genType step(genType edge, genType x)',
  smoothstep: 'genType smoothstep(genType e0, genType e1, genType x)', length: 'float length(genType v)',
  distance: 'float distance(genType a, genType b)', dot: 'float dot(genType a, genType b)',
  cross: 'vec3 cross(vec3 a, vec3 b)', normalize: 'genType normalize(genType v)', reflect: 'genType reflect(genType I, genType N)',
  refract: 'genType refract(genType I, genType N, float eta)', texture: 'vec4 texture(sampler2D s, vec2 uv)',
  radians: 'genType radians(genType degrees)', degrees: 'genType degrees(genType radians)',
  dFdx: 'genType dFdx(genType p)', dFdy: 'genType dFdy(genType p)', fwidth: 'genType fwidth(genType p)',
}

let registered = false
/** `kindOf` tells which built-ins apply to a model (3D/2D object shader or screen shader). */
export function registerGlsl(kindOf: (model: monaco.editor.ITextModel) => ShaderKind | null) {
  if (registered) return
  registered = true
  monaco.languages.register({ id: 'glsl', extensions: ['.glsl'], aliases: ['GLSL', 'glsl'] })
  monaco.languages.setLanguageConfiguration('glsl', {
    comments: { lineComment: '//', blockComment: ['/*', '*/'] },
    brackets: [['{', '}'], ['[', ']'], ['(', ')']],
    autoClosingPairs: [{ open: '{', close: '}' }, { open: '[', close: ']' }, { open: '(', close: ')' }],
    surroundingPairs: [{ open: '{', close: '}' }, { open: '[', close: ']' }, { open: '(', close: ')' }],
  })
  const builtinNames = [...new Set(Object.values(BUILTINS).flat().map((b) => b.name))]
  monaco.languages.setMonarchTokensProvider('glsl', {
    defaultToken: '',
    tokenPostfix: '.glsl',
    keywords: KEYWORDS.filter((k) => !k.startsWith('#')),
    typeKeywords: TYPES,
    builtins: builtinNames,
    functions: Object.keys(FUNCTIONS),
    tokenizer: {
      root: [
        [/^\s*#\s*\w+/, 'keyword'],
        [/[a-zA-Z_]\w*/, { cases: { '@typeKeywords': 'type', '@keywords': 'keyword', '@builtins': 'variable.predefined', '@functions': 'predefined', '@default': 'identifier' } }],
        { include: '@whitespace' },
        [/\d*\.\d+([eE][-+]?\d+)?f?/, 'number.float'],
        [/\d+\.?([eE][-+]?\d+)?f?/, 'number'],
        [/[{}()[\]]/, '@brackets'],
        [/[;,.]/, 'delimiter'],
        [/[=><!~?:&|+\-*/^%]+/, 'operator'],
      ],
      whitespace: [
        [/[ \t\r\n]+/, 'white'],
        [/\/\*/, 'comment', '@comment'],
        [/\/\/.*$/, 'comment'],
      ],
      comment: [
        [/[^/*]+/, 'comment'],
        [/\*\//, 'comment', '@pop'],
        [/[/*]/, 'comment'],
      ],
    },
  } as monaco.languages.IMonarchLanguage)

  monaco.languages.registerCompletionItemProvider('glsl', {
    provideCompletionItems(model, position) {
      const kind = kindOf(model) ?? '3d'
      const word = model.getWordUntilPosition(position)
      const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn)
      const K = monaco.languages.CompletionItemKind
      const items: monaco.languages.CompletionItem[] = []
      for (const b of BUILTINS[kind]) {
        const fn = b.type.includes('(')
        items.push({
          label: b.name, kind: fn ? K.Function : K.Variable, detail: b.type, documentation: b.doc, range, sortText: '0' + b.name,
          insertText: fn ? `${b.name}($0)` : b.name, insertTextRules: fn ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
        })
      }
      for (const [name, sig] of Object.entries(FUNCTIONS)) {
        items.push({ label: name, kind: K.Function, detail: sig, range, sortText: '1' + name, insertText: `${name}($0)`, insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet })
      }
      for (const t of TYPES) items.push({ label: t, kind: K.Class, insertText: t, range, sortText: '2' + t })
      for (const k of KEYWORDS) if (!k.startsWith('#')) items.push({ label: k, kind: K.Keyword, insertText: k, range, sortText: '3' + k })
      items.push({
        label: 'fragment', kind: K.Snippet, detail: 'vec4 fragment() { … }', range, sortText: '0fragment',
        insertText: 'vec4 fragment() {\n\t${0:return BASE;}\n}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
      })
      if (kind !== 'screen') items.push({
        label: 'vertex', kind: K.Snippet, detail: 'vec3 vertex() { … }', range, sortText: '0vertex',
        insertText: 'vec3 vertex() {\n\t${0:return POSITION;}\n}', insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
      })
      return { suggestions: items }
    },
  })

  monaco.languages.registerHoverProvider('glsl', {
    provideHover(model, position) {
      const w = model.getWordAtPosition(position)
      if (!w) return null
      const kind = kindOf(model) ?? '3d'
      const b = BUILTINS[kind].find((x) => x.name === w.word)
      const sig = FUNCTIONS[w.word]
      if (!b && !sig) return null
      return {
        range: new monaco.Range(position.lineNumber, w.startColumn, position.lineNumber, w.endColumn),
        contents: b ? [{ value: '```glsl\n' + (b.type.includes('(') ? b.type : `${b.type} ${b.name}`) + '\n```' }, { value: b.doc }] : [{ value: '```glsl\n' + sig + '\n```' }],
      }
    },
  })
}
