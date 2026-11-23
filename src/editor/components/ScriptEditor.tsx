// Monaco-based script editor for Luau, TypeScript and Python.
import { useEffect, useRef } from 'react'
import * as monaco from '../luau/monacoCore'
import EditorWorker from '../../../node_modules/monaco-editor/esm/vs/editor/editor.worker.js?worker'
import TsWorker from '../../../node_modules/monaco-editor/esm/vs/languages/features/typescript/ts.worker.js?worker'
import { registerLuau } from '../luau/language'
import { checkScript, complete, typeAt } from '../luau/analysis'
import { Instance } from '../../engine/instance'
import { DataModel } from '../../engine/classes'
import { placeCompletions, pythonCompletions } from '../completion/providers'
import { languageOf, ScriptLanguage } from '../../engine/scripting/languages'
import {
  MONACO_LANGUAGE, checkPython, loadPythonChecker, setupLanguages, syncTypeScriptWorkspace, uriFor,
} from '../languages/setup'
import { editor as store, useEditor } from '../store'
import { registerGlsl } from '../shaders/glsl'
import { attributeUniforms, checkShader, isShaderInstance, shaderKindFor } from '../../engine/render/shaders'

;(self as any).MonacoEnvironment = {
  getWorker: (_id: string, label: string) => (label === 'typescript' || label === 'javascript' ? new TsWorker() : new EditorWorker()),
}
registerLuau()
setupLanguages()
registerGlsl((model) => { const s = byUri.get(model.uri.toString()); return s && isShaderInstance(s) ? shaderKindFor(s) : null })

const models = new Map<Instance, monaco.editor.ITextModel>()
const byUri = new Map<string, Instance>()

/**
 * The model at a script's address. One may already exist for an earlier copy of the same script
 * (after undo, or a TypeScript script at the same path): it then takes this script's current source.
 */
function adoptModel(uri: monaco.Uri, script: Instance, language: string) {
  const source = script.get<string>('Source') ?? ''
  const m = monaco.editor.getModel(uri)
  if (!m) return monaco.editor.createModel(source, language, uri)
  if (m.getValue() !== source) m.setValue(source)
  return m
}

/** One model per script; recreated if the script's language or (for TypeScript) its path changed. */
function modelFor(script: Instance) {
  if (isShaderInstance(script)) {
    let m = models.get(script)
    if (m && !m.isDisposed()) return m
    const uri = monaco.Uri.parse(`inmemory://shaders/${script.id}.glsl`)
    m = adoptModel(uri, script, 'glsl')
    models.set(script, m)
    byUri.set(uri.toString(), script)
    return m
  }
  const lang = languageOf(script)
  const uriText = uriFor(script, lang)
  let m = models.get(script)
  if (m && !m.isDisposed()) {
    if (m.uri.toString() === monaco.Uri.parse(uriText).toString() && m.getLanguageId() === MONACO_LANGUAGE[lang]) return m
    byUri.delete(m.uri.toString())
    m.dispose()
  }
  const uri = monaco.Uri.parse(uriText)
  m = adoptModel(uri, script, MONACO_LANGUAGE[lang])
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

const gameOf = (script: Instance) => (script.dataModel ?? store.game) as DataModel

let providersRegistered = false
function registerProviders() {
  if (providersRegistered) return
  providersRegistered = true
  monaco.languages.registerCompletionItemProvider('luau', {
    triggerCharacters: ['.', ':', '"', "'"],
    async provideCompletionItems(model, position) {
      const script = byUri.get(model.uri.toString())
      if (!script) return { suggestions: [] }
      // 1. the place-aware resolver (children, services, locals, event parameters, string arguments)
      const placed = placeCompletions(model, position, script, gameOf(script), 'Luau')
      if (placed?.exclusive) return { suggestions: placed.items }
      // 2. the Luau type checker for everything else
      const entries = await complete(script.id, model.getValue(), position.lineNumber - 1, position.column - 1)
      const word = model.getWordUntilPosition(position)
      const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn)
      const lineBefore = model.getLineContent(position.lineNumber).slice(0, word.startColumn - 1)
      const afterColon = /:\s*$/.test(lineBefore)
      const suggestions: monaco.languages.CompletionItem[] = (entries ?? [])
        .filter((e) => {
          if (!e.label || !e.label.trim() || e.wrongIndexType || e.label.startsWith('__') || e.label.startsWith('@')) return false
          if (e.kind === 'type' && !/^[A-Za-z_]/.test(e.label)) return false
          // after ':' only callable members make sense
          if (afterColon && !(e.parentheses !== 'none' || (e.type && /->/.test(e.type)))) return false
          return true
        })
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
  // TypeScript: Monaco's TS service provides types; we add place children and string arguments
  monaco.languages.registerCompletionItemProvider('typescript', {
    triggerCharacters: ['.', '"', "'"],
    provideCompletionItems(model, position) {
      const script = byUri.get(model.uri.toString())
      if (!script) return { suggestions: [] }
      const placed = placeCompletions(model, position, script, gameOf(script), 'TypeScript', { childrenOnly: true })
      return { suggestions: placed?.items ?? [] }
    },
  })
  monaco.languages.registerCompletionItemProvider('python', {
    triggerCharacters: ['.', '"', "'", ' '],
    provideCompletionItems(model, position) {
      const script = byUri.get(model.uri.toString())
      if (!script) return { suggestions: [] }
      return { suggestions: pythonCompletions(model, position, script, gameOf(script)) }
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
  const lang: ScriptLanguage = languageOf(script)
  const isShader = isShaderInstance(script)

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
      wordBasedSuggestions: 'off', // only real API/place suggestions, no random words from the file
      suggest: { showWords: false, localityBonus: true, preview: true },
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
    if (lang === 'TypeScript') syncTypeScriptWorkspace(script.dataModel ?? store.game, (s) => { modelFor(s) })
    if (lang === 'Python') void loadPythonChecker().then(() => runCheck())
    const model = modelFor(script)
    if (e.getModel() !== model) e.setModel(model)
    e.updateOptions({ readOnly, insertSpaces: !isShader && lang === 'Python', tabSize: 4 })
    let timer: number | null = null
    const runCheck = () => {
      if (model.isDisposed()) return
      if (isShader) {
        // compile in a hidden WebGL context: errors show while typing
        const errs = checkShader(model.getValue(), shaderKindFor(script), attributeUniforms(script))
        if (!errs) return
        monaco.editor.setModelMarkers(model, 'glsl', errs.map((er) => {
          const line = Math.min(Math.max(er.line ?? 1, 1), model.getLineCount())
          return { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: model.getLineMaxColumn(line), message: er.message, severity: monaco.MarkerSeverity.Error, source: 'GLSL' }
        }))
        return
      }
      if (lang === 'Python') {
        const markers = checkPython(model.getValue())
        if (markers) monaco.editor.setModelMarkers(model, 'python', markers)
        return
      }
      if (lang !== 'Luau') return // TypeScript is checked by Monaco's TypeScript service
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
  }, [script, readOnly, lang, isShader])

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
