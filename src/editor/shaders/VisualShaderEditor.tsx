// Visual shader editor: a shader is a list of plain-English steps with inline controls.
import { useEffect, useMemo, useState } from 'react'
import { Code2, Eye, EyeOff, GripVertical, Plus, Search, Sparkles, Sun, Trash2, X } from 'lucide-react'
import { Instance } from '../../engine/instance'
import { editor, useEditor } from '../store'
import { shaderKindFor } from '../../engine/render/shaders'
import {
  CATEGORIES, Category, ParamDef, Pattern, PATTERN_SHAPES, Recipe, RecipeKind, Step, compileRecipe, directionsFor,
  newStep, parseRecipe, patternLabel, patternUses, stepDef, stepsFor,
} from '../../engine/shaderRecipe'
import { ShaderPreview } from './ShaderPreview'

const CAT_CLASS: Record<Category, string> = {
  Colour: 'cat-colour', 'Light & glow': 'cat-light', 'See-through': 'cat-see', Movement: 'cat-move', Image: 'cat-image', 'Screen effects': 'cat-screen',
}

export function VisualShaderEditor({ shader }: { shader: Instance }) {
  useEditor() // re-render on edits / undo
  const kind = shaderKindFor(shader) as RecipeKind
  const recipe = parseRecipe(shader.get<string>('Recipe'))
  const readOnly = shader.dataModel !== editor.game
  const [adding, setAdding] = useState(false)
  const [showCode, setShowCode] = useState(false)
  const [drag, setDrag] = useState<{ id: string; over: string | null } | null>(null)
  const compiled = useMemo(() => (recipe ? compileRecipe(recipe, kind) : null), [shader.get<string>('Recipe'), kind]) // eslint-disable-line react-hooks/exhaustive-deps

  // a shader moved between a 3D part and a 2D sprite: regenerate its GLSL for the new kind
  useEffect(() => {
    if (compiled && !readOnly && compiled.source !== shader.get<string>('Source')) { shader.set('Source', compiled.source); editor.emit() }
  }, [compiled, readOnly, shader])

  if (!recipe || !compiled) return null

  /** Save a new recipe (and its generated GLSL). Sliders checkpoint once when the drag starts. */
  const commit = (next: Recipe, checkpoint = true) => {
    if (readOnly) return
    const out = compileRecipe(next, kind)
    const apply = () => {
      shader.set('Recipe', JSON.stringify(next))
      shader.set('Source', out.source)
      if (shader.className === 'Shader' && kind === '3d' && !!shader.get('Transparent') !== out.transparent) shader.set('Transparent', out.transparent)
    }
    if (checkpoint) editor.mutate(apply)
    else { apply(); editor.emit() }
  }
  const setStep = (id: string, fn: (s: Step) => Step, checkpoint = true) =>
    commit({ ...recipe, steps: recipe.steps.map((s) => (s.id === id ? fn(s) : s)) }, checkpoint)
  const setParam = (id: string, key: string, value: unknown, checkpoint = true) =>
    setStep(id, (s) => ({ ...s, params: { ...s.params, [key]: value } }), checkpoint)
  const move = (id: string, before: string | null) => {
    const steps = recipe.steps.filter((s) => s.id !== id)
    const moving = recipe.steps.find((s) => s.id === id)!
    const at = before ? steps.findIndex((s) => s.id === before) : steps.length
    steps.splice(at < 0 ? steps.length : at, 0, moving)
    commit({ ...recipe, steps })
  }
  const convertToCode = () => {
    if (!window.confirm('Switch this shader to GLSL code?\n\nYou can edit everything by hand afterwards, but the steps editor won\'t be able to open it again (Undo brings it back).')) return
    editor.mutate(() => shader.set('Recipe', ''))
  }

  const steps = recipe.steps.filter((s) => stepDef(s.type)?.kinds.includes(kind))
  const kindLabel = kind === 'screen' ? 'Screen effect' : kind === '2d' ? '2D shader' : '3D shader'

  return (
    <div className="visual-shader">
      <div className="vs-main">
        <div className="vs-header">
          <Sparkles size={16} />
          <div>
            <div className="vs-title">{shader.name} <span className="vs-kind">{kindLabel}</span></div>
            <div className="vs-sub">
              {kind === 'screen' ? 'Changes how the whole screen looks. Steps run from top to bottom.' : `Changes how ${shader.parent?.name ?? 'its object'} looks. Steps run from top to bottom.`}
            </div>
          </div>
        </div>
        {readOnly && <div className="script-banner">This shader belongs to the running game and is read-only. Stop the game to edit.</div>}

        <div className="vs-steps">
          {/* how the colour starts */}
          <div className="vs-step vs-start">
            <span className="vs-num">1</span>
            <div className="vs-sentence">
              {kind === 'screen' ? <span>Start with what's on the screen</span> : (
                <>
                  <span>Start with</span>
                  <select value={recipe.start.mode} disabled={readOnly} onChange={(e) => commit({ ...recipe, start: { ...recipe.start, mode: e.target.value as Recipe['start']['mode'] } })}>
                    <option value="own">the object's own look</option>
                    <option value="color">one colour</option>
                    <option value="pattern">two colours in a pattern</option>
                  </select>
                  {recipe.start.mode !== 'own' && <ColorInput value={recipe.start.color} disabled={readOnly} onChange={(v, c) => commit({ ...recipe, start: { ...recipe.start, color: v } }, c)} />}
                  {recipe.start.mode === 'pattern' && (
                    <>
                      <span>and</span>
                      <ColorInput value={recipe.start.color2} disabled={readOnly} onChange={(v, c) => commit({ ...recipe, start: { ...recipe.start, color2: v } }, c)} />
                      <span>in</span>
                      <PatternInput kind={kind} value={recipe.start.pattern} disabled={readOnly} onChange={(v, c) => commit({ ...recipe, start: { ...recipe.start, pattern: v } }, c)} />
                    </>
                  )}
                </>
              )}
            </div>
          </div>

          {steps.map((s, i) => {
            const def = stepDef(s.type)!
            return (
              <div
                key={s.id}
                className={`vs-step ${CAT_CLASS[def.category]}${s.on ? '' : ' off'}${drag?.over === s.id ? ' drop-before' : ''}`}
                onDragOver={(e) => { if (drag) { e.preventDefault(); if (drag.over !== s.id) setDrag({ ...drag, over: s.id }) } }}
                onDrop={(e) => { e.preventDefault(); if (drag && drag.id !== s.id) move(drag.id, s.id); setDrag(null) }}
              >
                <span
                  className="vs-grip" title="Drag to reorder" draggable={!readOnly}
                  onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', s.id); setDrag({ id: s.id, over: null }) }}
                  onDragEnd={() => setDrag(null)}
                ><GripVertical size={14} /></span>
                <span className="vs-num">{i + 2}</span>
                <div className="vs-sentence" title={def.description}>
                  {renderSentence(def.sentence, def.params, s, kind, readOnly, (key, v, c) => setParam(s.id, key, v, c))}
                </div>
                <div className="vs-actions">
                  <button className="icon-btn" disabled={readOnly} title={s.on ? 'Turn this step off' : 'Turn this step on'} onClick={() => setStep(s.id, (x) => ({ ...x, on: !x.on }))}>
                    {s.on ? <Eye size={14} /> : <EyeOff size={14} />}
                  </button>
                  <button className="icon-btn" disabled={readOnly} title="Remove this step" onClick={() => commit({ ...recipe, steps: recipe.steps.filter((x) => x.id !== s.id) })}>
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            )
          })}
          {drag && (
            <div className={`vs-drop-end${drag.over === null ? ' on' : ''}`}
              onDragOver={(e) => { e.preventDefault(); if (drag.over !== null) setDrag({ ...drag, over: null }) }}
              onDrop={(e) => { e.preventDefault(); move(drag.id, null); setDrag(null) }}>Drop here to move to the end</div>
          )}

          {kind === '3d' && (
            <label className="vs-step vs-light">
              <Sun size={14} />
              <input type="checkbox" checked={recipe.lit !== false} disabled={readOnly} onChange={(e) => commit({ ...recipe, lit: e.target.checked })} />
              <span>Light it with the sun (untick for a flat, glowing look)</span>
            </label>
          )}

          {!readOnly && (adding
            ? <StepPicker kind={kind} onPick={(type) => { commit({ ...recipe, steps: [...recipe.steps, newStep(type)] }); setAdding(false) }} onClose={() => setAdding(false)} />
            : <button className="vs-add" onClick={() => setAdding(true)}><Plus size={15} /> Add a step</button>)}
        </div>
      </div>

      <div className="vs-side">
        <div className="vs-side-title">Preview</div>
        <ShaderPreview shader={shader} source={compiled.source} kind={kind} transparent={compiled.transparent} />
        <div className="vs-hint">
          {kind === 'screen' ? 'A sample picture. Press Play to see it on your game.' : kind === '2d' ? `${shader.parent?.name ?? 'The object'} with this shader. It also updates in the 2D view.` : 'A ball with this shader. Your object updates too: close this tab to see it.'}
        </div>
        <div className="vs-side-actions">
          <button className="btn small" onClick={() => setShowCode(!showCode)}><Code2 size={13} /> {showCode ? 'Hide the code' : 'Show the code'}</button>
          {!readOnly && <button className="btn small" onClick={convertToCode} title="Edit the generated GLSL by hand">Convert to code…</button>}
        </div>
        {showCode && <pre className="vs-code">{compiled.source}</pre>}
      </div>
    </div>
  )
}

/** Sentence text with inline controls in place of {key}. */
function renderSentence(sentence: string, defs: ParamDef[], step: Step, kind: RecipeKind, disabled: boolean, set: (key: string, v: unknown, checkpoint: boolean) => void) {
  return sentence.split(/(\{\w+\})/).filter(Boolean).map((part, i) => {
    const m = /^\{(\w+)\}$/.exec(part)
    if (!m) return <span key={i}>{part}</span>
    const def = defs.find((d) => d.key === m[1])
    if (!def) return null
    return <ParamInput key={i} def={def} kind={kind} value={step.params[def.key]} disabled={disabled} onChange={(v, c) => set(def.key, v, c)} />
  })
}

type OnChange<T> = (v: T, checkpoint: boolean) => void

function ParamInput({ def, value, onChange, kind, disabled }: { def: ParamDef; value: unknown; onChange: OnChange<unknown>; kind: RecipeKind; disabled: boolean }) {
  switch (def.type) {
    case 'color': return <ColorInput value={String(value)} onChange={onChange} disabled={disabled} />
    case 'percent': return <RangeInput value={Number(value)} min={0} max={100} step={1} suffix="%" onChange={onChange} disabled={disabled} />
    case 'number': return <RangeInput value={Number(value)} min={def.min ?? 0} max={def.max ?? 10} step={def.step ?? 0.1} onChange={onChange} disabled={disabled} />
    case 'choice': return (
      <select value={String(value)} disabled={disabled} onChange={(e) => onChange(e.target.value, true)}>
        {def.choices!.filter(([v]) => kind === '3d' || v !== 'forward').map(([v, label]) => <option key={v} value={v}>{label}</option>)}
      </select>
    )
    case 'bool': return <input type="checkbox" checked={!!value} disabled={disabled} onChange={(e) => onChange(e.target.checked, true)} />
    case 'pattern': return <PatternInput value={value as Pattern} kind={kind} onChange={onChange} disabled={disabled} />
  }
}

function ColorInput({ value, onChange, disabled }: { value: string; onChange: OnChange<string>; disabled: boolean }) {
  // the picker fires continuously while dragging: one undo step per open
  const [opened, setOpened] = useState(false)
  return (
    <label className="vs-color" style={{ background: value }} title={value}>
      <input type="color" value={value} disabled={disabled}
        onFocus={() => setOpened(false)}
        onChange={(e) => { onChange(e.target.value, !opened); setOpened(true) }} />
    </label>
  )
}

function RangeInput({ value, min, max, step, suffix = '', onChange, disabled }: { value: number; min: number; max: number; step: number; suffix?: string; onChange: OnChange<number>; disabled: boolean }) {
  const [dragging, setDragging] = useState(false)
  return (
    <span className="vs-range">
      <input type="range" min={min} max={max} step={step} value={value} disabled={disabled}
        onPointerDown={() => { editor.checkpoint(); setDragging(true) }}
        onPointerUp={() => setDragging(false)}
        onKeyDown={() => { if (!dragging) editor.checkpoint() }}
        onChange={(e) => onChange(Number(e.target.value), false)} />
      <output>{step < 1 ? Number(value).toFixed(1).replace(/\.0$/, '') : value}{suffix}</output>
    </span>
  )
}

function PatternInput({ value, onChange, kind, disabled }: { value: Pattern; onChange: OnChange<Pattern>; kind: RecipeKind; disabled: boolean }) {
  const uses = patternUses(value.shape)
  const set = (patch: Partial<Pattern>, checkpoint: boolean) => onChange({ ...value, ...patch }, checkpoint)
  return (
    <span className="vs-pattern">
      <select value={value.shape} disabled={disabled} onChange={(e) => set({ shape: e.target.value as Pattern['shape'] }, true)}>
        {PATTERN_SHAPES.map((s) => <option key={s} value={s}>{patternLabel(s)}</option>)}
      </select>
      {uses.size && <><span>size</span><RangeInput value={value.size} min={0.1} max={10} step={0.1} disabled={disabled} onChange={(v, c) => set({ size: v }, c)} /></>}
      {uses.speed && <><span>moving at speed</span><RangeInput value={value.speed} min={0} max={5} step={0.1} disabled={disabled} onChange={(v, c) => set({ speed: v }, c)} /></>}
      {uses.direction && (
        <>
          <span>{value.shape === 'gradient' ? 'towards' : 'going'}</span>
          <select value={value.direction} disabled={disabled} onChange={(e) => set({ direction: e.target.value as Pattern['direction'] }, true)}>
            {directionsFor(kind).map(([d, label]) => <option key={d} value={d}>{value.shape === 'gradient' ? (d === 'up' ? 'the top' : d === 'down' ? 'the bottom' : label) : label}</option>)}
          </select>
        </>
      )}
    </span>
  )
}

function StepPicker({ kind, onPick, onClose }: { kind: RecipeKind; onPick: (type: string) => void; onClose: () => void }) {
  const [q, setQ] = useState('')
  const all = stepsFor(kind).filter((s) => !q || `${s.name} ${s.description}`.toLowerCase().includes(q.toLowerCase()))
  return (
    <div className="vs-picker">
      <div className="vs-picker-head">
        <Search size={13} />
        <input autoFocus placeholder="What should it do? (e.g. glow, stripes, wobble)" value={q} onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') onClose(); if (e.key === 'Enter' && all[0]) onPick(all[0].type) }} />
        <button className="icon-btn" title="Close" onClick={onClose}><X size={14} /></button>
      </div>
      {CATEGORIES.map((cat) => {
        const items = all.filter((s) => s.category === cat)
        if (!items.length) return null
        return (
          <div key={cat} className="vs-picker-cat">
            <div className="vs-picker-label">{cat}</div>
            <div className="vs-picker-grid">
              {items.map((s) => (
                <button key={s.type} className={`vs-picker-item ${CAT_CLASS[s.category]}`} onClick={() => onPick(s.type)}>
                  <b>{s.name}</b>
                  <span>{s.description}</span>
                </button>
              ))}
            </div>
          </div>
        )
      })}
      {!all.length && <div className="muted small pad">No steps match "{q}".</div>}
    </div>
  )
}
