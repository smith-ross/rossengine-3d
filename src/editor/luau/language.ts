// Luau language registration for Monaco: tokenizer, editor config and theme.
import * as monaco from './monacoCore'

let registered = false

export function registerLuau() {
  if (registered) return
  registered = true
  monaco.languages.register({ id: 'luau', extensions: ['.luau', '.lua'], aliases: ['Luau', 'luau'] })

  monaco.languages.setLanguageConfiguration('luau', {
    comments: { lineComment: '--', blockComment: ['--[[', ']]'] },
    brackets: [['{', '}'], ['[', ']'], ['(', ')']],
    autoClosingPairs: [
      { open: '{', close: '}' }, { open: '[', close: ']' }, { open: '(', close: ')' },
      { open: '"', close: '"', notIn: ['string'] }, { open: "'", close: "'", notIn: ['string'] },
      { open: '`', close: '`', notIn: ['string'] },
    ],
    surroundingPairs: [
      { open: '{', close: '}' }, { open: '[', close: ']' }, { open: '(', close: ')' },
      { open: '"', close: '"' }, { open: "'", close: "'" },
    ],
    indentationRules: {
      increaseIndentPattern: /^\s*((\b(else|function|then|do|repeat)\b((?!\b(end|until)\b).)*)|(\{\s*)|(.*\b(function)\b\s*\(.*\)\s*))$/,
      decreaseIndentPattern: /^\s*((\b(elseif|else|end|until)\b)|(\})|(\)))/,
    },
    onEnterRules: [],
    wordPattern: /(-?\d*\.\d\w*)|([^`~!@#%^&*()\-=+[{\]}\\|;:'",.<>/?\s]+)/g,
  })

  monaco.languages.setMonarchTokensProvider('luau', {
    defaultToken: '',
    tokenPostfix: '.luau',
    keywords: [
      'and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for', 'function', 'if', 'in', 'local', 'nil', 'not',
      'or', 'repeat', 'return', 'then', 'true', 'until', 'while', 'continue', 'type', 'export', 'typeof',
    ],
    builtins: [
      'game', 'workspace', 'script', 'Instance', 'Vector3', 'Vector2', 'CFrame', 'Color3', 'BrickColor', 'UDim', 'UDim2',
      'Enum', 'TweenInfo', 'Ray', 'RaycastParams', 'Random', 'task', 'wait', 'spawn', 'delay', 'tick', 'time', 'print',
      'warn', 'error', 'require', 'pairs', 'ipairs', 'next', 'select', 'tostring', 'tonumber', 'type', 'typeof', 'pcall',
      'xpcall', 'assert', 'math', 'string', 'table', 'coroutine', 'os', 'debug', 'bit32', 'utf8', 'buffer', 'setmetatable',
      'getmetatable', 'rawget', 'rawset', 'rawequal', 'rawlen', 'unpack', 'shared', '_G', 'self',
    ],
    typeKeywords: ['number', 'string', 'boolean', 'any', 'never', 'unknown', 'thread', 'userdata'],
    operators: ['+', '-', '*', '/', '//', '%', '^', '#', '==', '~=', '<=', '>=', '<', '>', '=', '+=', '-=', '*=', '/=', '//=', '%=', '^=', '..=', '..', '...', '->', '::'],
    symbols: /[=><!~?:&|+\-*/^%#.]+/,
    escapes: /\\(?:[abfnrtvz\\"'`{}]|x[0-9A-Fa-f]{2}|u\{[0-9A-Fa-f]+\}|\d{1,3})/,
    tokenizer: {
      root: [
        [/--\[(=*)\[/, { token: 'comment', next: '@blockComment.$1' }],
        [/--.*$/, 'comment'],
        [/\[(=*)\[/, { token: 'string', next: '@longString.$1' }],
        [/[a-zA-Z_]\w*(?=\s*\()/, { cases: { '@keywords': 'keyword', '@builtins': 'predefined', '@default': 'function' } }],
        [/[a-zA-Z_]\w*/, { cases: { '@keywords': 'keyword', '@builtins': 'predefined', '@typeKeywords': 'type', '@default': 'identifier' } }],
        { include: '@whitespace' },
        [/[{}()[\]]/, '@brackets'],
        [/@symbols/, { cases: { '@operators': 'operator', '@default': '' } }],
        [/0[xX][0-9a-fA-F_]+/, 'number.hex'],
        [/0[bB][01_]+/, 'number'],
        [/\d[\d_]*(\.\d[\d_]*)?([eE][-+]?\d+)?/, 'number'],
        [/\.\d+([eE][-+]?\d+)?/, 'number'],
        [/[;,.]/, 'delimiter'],
        [/"/, { token: 'string', next: '@dstring' }],
        [/'/, { token: 'string', next: '@sstring' }],
        [/`/, { token: 'string', next: '@istring' }],
      ],
      whitespace: [[/[ \t\r\n]+/, '']],
      blockComment: [
        [/\](=*)\]/, { cases: { '$1==$S2': { token: 'comment', next: '@pop' }, '@default': 'comment' } }],
        [/./, 'comment'],
      ],
      longString: [
        [/\](=*)\]/, { cases: { '$1==$S2': { token: 'string', next: '@pop' }, '@default': 'string' } }],
        [/./, 'string'],
      ],
      dstring: [[/[^\\"]+/, 'string'], [/@escapes/, 'string.escape'], [/\\./, 'string.escape.invalid'], [/"/, { token: 'string', next: '@pop' }]],
      sstring: [[/[^\\']+/, 'string'], [/@escapes/, 'string.escape'], [/\\./, 'string.escape.invalid'], [/'/, { token: 'string', next: '@pop' }]],
      istring: [
        [/\{/, { token: 'delimiter.bracket', next: '@interp' }],
        [/[^\\`{]+/, 'string'],
        [/@escapes/, 'string.escape'],
        [/`/, { token: 'string', next: '@pop' }],
      ],
      interp: [[/\}/, { token: 'delimiter.bracket', next: '@pop' }], { include: 'root' }],
    },
  } as any)

  monaco.editor.defineTheme('ross-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'keyword', foreground: 'f86d7c', fontStyle: 'bold' },
      { token: 'predefined', foreground: '84d6f7' },
      { token: 'function', foreground: 'fdfbac' },
      { token: 'identifier', foreground: 'cccccc' },
      { token: 'type', foreground: '84d6f7' },
      { token: 'number', foreground: 'ffc600' },
      { token: 'string', foreground: 'adf195' },
      { token: 'string.escape', foreground: 'f4b46a' },
      { token: 'comment', foreground: '666666', fontStyle: 'italic' },
      { token: 'operator', foreground: 'cccccc' },
    ],
    colors: {
      'editor.background': '#1e1f24',
      'editor.lineHighlightBackground': '#2a2c33',
      'editorLineNumber.foreground': '#5a5d66',
      'editorGutter.background': '#1e1f24',
    },
  })
}
