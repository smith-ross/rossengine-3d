import { useEffect, useState } from 'react'
import { CFrame, Color3, EnumItem, Enums, UDim, UDim2, Vector2, Vector3, enumItem } from '../../engine/datatypes'
import { Instance, PropDef } from '../../engine/instance'
import { editor, useEditor } from '../store'
import { ChevronDown, ChevronRight, Upload } from 'lucide-react'
import { AssetKind, assets, contentRef } from '../../engine/assets'
import { importFiles, pickFiles } from '../assetOps'
import { useAssets } from './AssetsPanel'
import { SpriteTools } from './SpriteTools'

const collapsed = new Set<string>()

const CATEGORY_ORDER = ['Data', 'Appearance', 'Text', 'Image', 'Transform', 'Layout', 'Behavior', 'Physics', 'Game', 'Camera', 'Character', 'Fog', 'Constraints', 'Other']

export function Properties() {
  const ed = useEditor()
  const sel = ed.selection
  const [, force] = useState(0)
  useEffect(() => {
    // live refresh while playing (physics moves things)
    if (!ed.playing) return
    const t = setInterval(() => force((x) => x + 1), 250)
    return () => clearInterval(t)
  }, [ed.playing])

  if (!sel.length) {
    return (
      <div className="panel properties">
        <div className="panel-title">Properties</div>
        <div className="panel-empty">Select an object to see its properties.</div>
      </div>
    )
  }
  const first = sel[0]
  // properties common to all selected instances
  const props = [...first.classInfo.props.entries()].filter(
    ([name, def]) => !def.hidden && name !== 'ClassName' && sel.every((s) => s.classInfo.props.has(name)),
  )
  const groups = new Map<string, Array<[string, PropDef]>>()
  for (const p of props) {
    const cat = p[1].category ?? 'Other'
    if (!groups.has(cat)) groups.set(cat, [])
    groups.get(cat)!.push(p)
  }
  const ordered = [...groups.entries()].sort((a, b) => CATEGORY_ORDER.indexOf(a[0]) - CATEGORY_ORDER.indexOf(b[0]))
  const title = sel.length > 1 ? `${sel.length} objects` : `${first.className} "${first.name}"`

  return (
    <div className="panel properties">
      <div className="panel-title">Properties — {title}</div>
      <div className="props-scroll">
        {ordered.map(([cat, list]) => (
          <div key={cat} className="prop-group">
            <div className="prop-cat" onClick={() => { if (collapsed.has(cat)) collapsed.delete(cat); else collapsed.add(cat); force((x) => x + 1) }}>
              {collapsed.has(cat) ? <ChevronRight size={12} /> : <ChevronDown size={12} />} {cat}
            </div>
            {!collapsed.has(cat) && list.map(([name, def]) => (
              <PropRow key={name + first.id} name={name} def={def} insts={sel} />
            ))}
          </div>
        ))}
        {sel.length === 1 && ['Sprite2D', 'AnimatedSprite2D', 'SpriteAnimation'].includes(first.className) && <SpriteTools inst={first} />}
        <Attributes inst={first} />
      </div>
    </div>
  )
}

function PropRow({ name, def, insts }: { name: string; def: PropDef; insts: Instance[] }) {
  const value = insts[0].get(name)
  const readonly = !!def.readonly || (name === 'Parent') || (name === 'Name' && insts[0].parentLocked)
  const commit = (v: unknown) => {
    if (readonly) return
    const apply = () => { for (const i of insts) try { i.set(name, v) } catch (e) { editor.log('error', String((e as Error).message)) } }
    if (editor.playing) apply()
    else editor.mutate(apply)
  }
  return (
    <div className="prop-row">
      <div className="prop-name" title={name}>{name}</div>
      <div className="prop-value">
        {def.type === 'Content'
          ? <ContentEditor kind={def.content ?? 'image'} value={String(value ?? '')} readonly={readonly} onCommit={commit} />
          : <ValueEditor type={def.type} value={value} readonly={readonly} onCommit={commit} />}
      </div>
    </div>
  )
}

function NumberInput({ value, onCommit, readonly, step }: { value: number; onCommit: (v: number) => void; readonly?: boolean; step?: number }) {
  const [text, setText] = useState(fmt(value))
  useEffect(() => setText(fmt(value)), [value])
  return (
    <input
      className="prop-input num"
      value={text}
      readOnly={readonly}
      step={step}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); e.stopPropagation() }}
      onBlur={() => {
        const n = evalNumber(text)
        if (n === null || n === value) setText(fmt(value))
        else onCommit(n)
      }}
    />
  )
}

function TextInput({ value, onCommit, readonly }: { value: string; onCommit: (v: string) => void; readonly?: boolean }) {
  const [text, setText] = useState(value)
  useEffect(() => setText(value), [value])
  return (
    <input
      className="prop-input"
      value={text}
      readOnly={readonly}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); e.stopPropagation() }}
      onBlur={() => { if (text !== value) onCommit(text) }}
    />
  )
}

function ValueEditor({ type, value, readonly, onCommit }: { type: string; value: unknown; readonly: boolean; onCommit: (v: unknown) => void }) {
  switch (type) {
    case 'string':
      return <TextInput value={String(value ?? '')} readonly={readonly} onCommit={onCommit} />
    case 'number': case 'int':
      return <NumberInput value={Number(value ?? 0)} readonly={readonly} onCommit={(n) => onCommit(type === 'int' ? Math.trunc(n) : n)} />
    case 'bool':
      return <input type="checkbox" checked={!!value} disabled={readonly} onChange={(e) => onCommit(e.target.checked)} />
    case 'Vector3': {
      const v = value as Vector3
      return (
        <div className="vec">
          <NumberInput value={v.x} readonly={readonly} onCommit={(n) => onCommit(new Vector3(n, v.y, v.z))} />
          <NumberInput value={v.y} readonly={readonly} onCommit={(n) => onCommit(new Vector3(v.x, n, v.z))} />
          <NumberInput value={v.z} readonly={readonly} onCommit={(n) => onCommit(new Vector3(v.x, v.y, n))} />
        </div>
      )
    }
    case 'Vector2': {
      const v = value as Vector2
      return (
        <div className="vec">
          <NumberInput value={v.x} readonly={readonly} onCommit={(n) => onCommit(new Vector2(n, v.y))} />
          <NumberInput value={v.y} readonly={readonly} onCommit={(n) => onCommit(new Vector2(v.x, n))} />
        </div>
      )
    }
    case 'UDim': {
      const v = value as UDim
      return (
        <div className="vec">
          <NumberInput value={v.scale} readonly={readonly} onCommit={(n) => onCommit(new UDim(n, v.offset))} />
          <NumberInput value={v.offset} readonly={readonly} onCommit={(n) => onCommit(new UDim(v.scale, n))} />
        </div>
      )
    }
    case 'UDim2': {
      const v = value as UDim2
      return (
        <div className="vec udim2" title="{X scale, X offset}, {Y scale, Y offset}">
          <NumberInput value={v.xs} readonly={readonly} onCommit={(n) => onCommit(new UDim2(n, v.xo, v.ys, v.yo))} />
          <NumberInput value={v.xo} readonly={readonly} onCommit={(n) => onCommit(new UDim2(v.xs, n, v.ys, v.yo))} />
          <NumberInput value={v.ys} readonly={readonly} onCommit={(n) => onCommit(new UDim2(v.xs, v.xo, n, v.yo))} />
          <NumberInput value={v.yo} readonly={readonly} onCommit={(n) => onCommit(new UDim2(v.xs, v.xo, v.ys, n))} />
        </div>
      )
    }
    case 'Color3': {
      const c = value as Color3
      return (
        <div className="color">
          <input type="color" value={c.toHex()} disabled={readonly} onChange={(e) => onCommit(Color3.fromHex(e.target.value))} />
          <TextInput
            value={c.toString()}
            readonly={readonly}
            onCommit={(t) => {
              const parts = t.split(/[,\s]+/).map(Number).filter((n) => !isNaN(n))
              if (parts.length === 3) onCommit(Color3.fromRGB(parts[0], parts[1], parts[2]))
            }}
          />
        </div>
      )
    }
    case 'CFrame': {
      const cf = value as CFrame
      return <span className="prop-readonly">{cf.position.toString()}</span>
    }
    case 'Instance': {
      const i = value as Instance | null
      return (
        <span className={`prop-ref${i ? '' : ' empty'}`} onClick={() => i && editor.select([i])} title="Click to select">
          {i ? i.name : '—'}
        </span>
      )
    }
  }
  if (type.startsWith('Enum.')) {
    const enumType = type.slice(5)
    const cur = value as EnumItem | null
    return (
      <select className="prop-input" value={cur?.name ?? ''} disabled={readonly} onChange={(e) => onCommit(enumItem(enumType, e.target.value))}>
        {(Enums[enumType] ?? []).map((n) => <option key={n} value={n}>{n}</option>)}
      </select>
    )
  }
  return <span className="prop-readonly">{String(value)}</span>
}

/** Pick an imported asset (or import a new file) for a Content property. */
function ContentEditor({ kind, value, readonly, onCommit }: { kind: AssetKind; value: string; readonly: boolean; onCommit: (v: string) => void }) {
  useAssets()
  const list = assets.list(kind)
  const current = assets.resolve(value)
  const url = kind === 'image' ? assets.url(value) : null
  const IMPORT = '__import__'
  return (
    <div className="content-edit">
      {url && <img className="content-preview" src={url} alt="" />}
      <select
        className="prop-input"
        disabled={readonly}
        value={current ? contentRef(current) : value ? '__missing__' : ''}
        onChange={async (e) => {
          const v = e.target.value
          if (v === IMPORT) {
            const [a] = await importFiles(await pickFiles(kind, false))
            if (a) onCommit(contentRef(a))
            return
          }
          if (v !== '__missing__') onCommit(v)
        }}
      >
        <option value="">(none)</option>
        {value && !current && <option value="__missing__">⚠ missing: {value}</option>}
        {list.map((a) => <option key={a.id} value={contentRef(a)}>{a.name}</option>)}
        <option value={IMPORT}>Import {kind === 'mesh' ? 'model' : kind} file…</option>
      </select>
      {!readonly && (
        <button className="icon-btn plain" title={`Import ${kind} file`} onClick={async () => {
          const [a] = await importFiles(await pickFiles(kind, false))
          if (a) onCommit(contentRef(a))
        }}><Upload size={13} /></button>
      )}
    </div>
  )
}

function Attributes({ inst }: { inst: Instance }) {
  const ed = useEditor()
  const [name, setName] = useState('')
  const entries = [...inst.attributes.entries()]
  return (
    <div className="prop-group">
      <div className="prop-cat">Attributes</div>
      {entries.map(([k, v]) => (
        <div key={k} className="prop-row">
          <div className="prop-name" title={k}>{k}</div>
          <div className="prop-value attr">
            {typeof v === 'boolean' ? (
              <input type="checkbox" checked={v} onChange={(e) => setAttr(inst, k, e.target.checked)} />
            ) : typeof v === 'number' ? (
              <NumberInput value={v} onCommit={(n) => setAttr(inst, k, n)} />
            ) : (
              <TextInput value={String(v)} onCommit={(t) => setAttr(inst, k, t)} />
            )}
            <button className="icon-btn" title="Remove" onClick={() => setAttr(inst, k, null)}>✕</button>
          </div>
        </div>
      ))}
      {!ed.playing && (
        <div className="prop-row add-attr">
          <input className="prop-input" placeholder="New attribute name" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
          <select className="prop-input" id="attr-type" defaultValue="number">
            <option value="number">number</option>
            <option value="string">string</option>
            <option value="boolean">boolean</option>
          </select>
          <button
            className="btn small"
            disabled={!name.trim()}
            onClick={() => {
              const t = (document.getElementById('attr-type') as HTMLSelectElement).value
              setAttr(inst, name.trim(), t === 'number' ? 0 : t === 'boolean' ? false : '')
              setName('')
            }}
          >Add</button>
        </div>
      )}
    </div>
  )
}

function setAttr(inst: Instance, k: string, v: unknown) {
  const apply = () => {
    if (v === null) inst.attributes.delete(k)
    else inst.attributes.set(k, v)
    inst.changed('Attributes')
  }
  if (editor.playing) apply()
  else editor.mutate(apply)
}

function fmt(n: number) {
  return String(Math.round(n * 1000) / 1000)
}

/** Allow simple math in number fields like Studio (e.g. "4*2"). */
function evalNumber(text: string): number | null {
  const t = text.trim()
  if (!/^[-+*/().\d\s]+$/.test(t)) return null
  try {
    const v = Function(`"use strict"; return (${t})`)()
    return typeof v === 'number' && isFinite(v) ? v : null
  } catch {
    return null
  }
}
