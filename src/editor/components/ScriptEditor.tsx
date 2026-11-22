// Monaco-based Luau script editor.
import { useEffect, useRef } from 'react'
import * as monaco from '../luau/monacoCore'
import EditorWorker from '../../../node_modules/monaco-editor/esm/vs/editor/editor.worker.js?worker'
import { registerLuau } from '../luau/language'
import { checkScript, complete, typeAt } from '../luau/analysis'
import { Instance } from '../../engine/instance'
import { editor as store, useEditor } from '../store'

;(self as any).MonacoEnvironment = { getWorker: () => new EditorWorker() }
registerLuau()

const models = new Map<Instance, monaco.editor.ITextModel>()
const byUri = new Map<string, Instance>()

function modelFor(script: Instance) {
  let m = models.get(script)
  if (m && !m.isDisposed()) return m
  const uri = monaco.Uri.parse(`inmemory://scripts/${script.id}.luau`)
  m = monaco.editor.getModel(uri) ?? monaco.editor.createModel(script.get<string>('Source') ?? '', 'luau', uri)
  models.set(script, m)
  byUri.set(uri.toString(), script)
  return m
}

const KIND: Record<string, monaco.languages.CompletionItemKind> = {
  property: monaco.languages.CompletionItemKind.Field,
  binding: monaco.languages.CompletionItemKind.Variable,
  keyword: monaco.languages.CompletionItemKind.Keyword,
  string: monaco.languages.CompletionItemKind.Value,
  type: monaco.languages.CompletionItemKind.Class,
  module: monaco.languages.CompletionItemKind.Module,
  generatedFunction: monaco.languages.CompletionItemKind.Snippet,
  requirePath: monaco.languages.CompletionItemKind.File,
  hotComment: monaco.languages.CompletionItemKind.Keyword,
}

let providersRegistered = false
function registerProviders() {
  if (providersRegistered) return
  providersRegistered = true
  monaco.languages.registerCompletionItemProvider('luau', {
    triggerCharacters: ['.', ':', '"', "'"],
    async provideCompletionItems(model, position) {
      const script = byUri.get(model.uri.toString())
      if (!script) return { suggestions: [] }
      const entries = await complete(script.id, model.getValue(), position.lineNumber - 1, position.column - 1)
      const word = model.getWordUntilPosition(position)
      const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn)
      const suggestions: monaco.languages.CompletionItem[] = (entries ?? [])
        .filter((e) => !e.wrongIndexType && !e.label.startsWith('__'))
        .map((e) => {
          const isFn = !!e.type && /^\(?\s*\(?[^)]*\)?\s*->|^\(.*\) ->|^<.*>\(/.test(e.type) || e.parentheses !== 'none'
          let insert = e.insertText ?? e.label
          let rule: monaco.languages.CompletionItemInsertTextRule | undefined
          if (e.parentheses === 'cursorInside') { insert = `${insert}($0)`; rule = monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet }
          if (e.parentheses === 'cursorAfter') insert = `${insert}()`
          return {
            label: e.label,
            kind: isFn && e.kind === 'property' ? monaco.languages.CompletionItemKind.Method : KIND[e.kind] ?? monaco.languages.CompletionItemKind.Text,
            detail: e.type,
            insertText: insert,
            insertTextRules: rule,
            range,
            tags: e.deprecated ? [monaco.languages.CompletionItemTag.Deprecated] : [],
            sortText: (e.typeCorrect !== 'none' ? '0' : e.kind === 'keyword' ? '2' : '1') + e.label,
          }
        })
      return { suggestions }
    },
  })
  monaco.languages.registerHoverProvider('luau', {
    async provideHover(model, position) {
      const script = byUri.get(model.uri.toString())
      const word = model.getWordAtPosition(position)
      if (!script || !word) return null
      const t = await typeAt(script.id, model.getValue(), position.lineNumber - 1, position.column - 1)
      if (!t) return null
      return {
        range: new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn),
        contents: [{ value: '```luau\n' + t + '\n```' }],
      }
    },
  })
}

export function ScriptEditor({ script }: { script: Instance }) {
  const ed = useEditor()
  const hostRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const readOnly = script.dataModel !== store.game

  useEffect(() => {
    registerProviders()
    const e = monaco.editor.create(hostRef.current!, {
      theme: 'ross-dark',
      automaticLayout: true,
      fontFamily: 'Consolas, "Cascadia Code", "Fira Code", monospace',
      fontSize: 14,
      tabSize: 4,
      insertSpaces: false,
      minimap: { enabled: true, scale: 1 },
      scrollBeyondLastLine: false,
      smoothScrolling: true,
      renderWhitespace: 'selection',
      bracketPairColorization: { enabled: true },
      guides: { indentation: true, bracketPairs: true },
      quickSuggestions: { other: true, comments: false, strings: true },
      suggestOnTriggerCharacters: true,
      fixedOverflowWidgets: true,
    })
    e.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      window.dispatchEvent(new CustomEvent('ross:save'))
    })
    editorRef.current = e
    return () => {
      e.dispose()
      editorRef.current = null
    }
  }, [])

  // swap the model when the tab changes
  useEffect(() => {
    const e = editorRef.current
    if (!e) return
    const model = modelFor(script)
    if (e.getModel() !== model) e.setModel(model)
    e.updateOptions({ readOnly })
    let timer: number | null = null
    const runCheck = () => {
      void checkScript(script.id, model.getValue()).then((diags) => {
        if (!diags || model.isDisposed()) return
        monaco.editor.setModelMarkers(model, 'luau', diags.map((d) => ({
          startLineNumber: d.location.begin.line + 1,
          startColumn: d.location.begin.column + 1,
          endLineNumber: d.location.end.line + 1,
          endColumn: Math.max(d.location.end.column + 1, d.location.begin.column + 2),
          message: d.message,
          severity: d.severity === 'error' ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning,
          source: d.kind === 'lint' ? `Luau lint (${d.code})` : 'Luau',
        })))
      })
    }
    runCheck()
    const sub = model.onDidChangeContent(() => {
      if (!readOnly) script.set('Source', model.getValue())
      if (timer) clearTimeout(timer)
      timer = window.setTimeout(runCheck, 350)
    })
    e.focus()
    return () => { sub.dispose(); if (timer) clearTimeout(timer) }
  }, [script, readOnly])

  // jump to a line (from Output)
  useEffect(() => {
    const r = ed.revealLine
    const e = editorRef.current
    if (!r || r.script !== script || !e) return
    store.revealLine = null
    e.revealLineInCenter(r.line)
    e.setPosition({ lineNumber: r.line, column: 1 })
    e.focus()
  }, [ed.revealLine, script, ed])

  return (
    <div className="script-editor">
      {readOnly && <div className="script-banner">This script belongs to the running game and is read-only. Stop the game to edit.</div>}
      <div ref={hostRef} className="monaco-host" />
    </div>
  )
}

/** Drop models for scripts that no longer exist (e.g. after undo/open). */
export function pruneModels(alive: Set<Instance>) {
  for (const [inst, m] of models) {
    if (!alive.has(inst)) {
      byUri.delete(m.uri.toString())
      m.dispose()
      models.delete(inst)
    }
  }
}
