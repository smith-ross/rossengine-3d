// Properties-panel tools for 2D sprites: sprite-sheet frame picker, auto-size, animation preview.
import { useEffect, useMemo, useState } from 'react'
import { Maximize, Pause, Play, Plus } from 'lucide-react'
import { Vector2 } from '../../engine/datatypes'
import { Instance, createInstance } from '../../engine/instance'
import { parseFrames } from '../../engine/classes2d'
import { assets } from '../../engine/assets'
import { editor, useEditor } from '../store'

function useImage(content: string | undefined) {
  const [img, setImg] = useState<{ url: string; w: number; h: number } | null>(null)
  useEffect(() => {
    const url = content ? assets.url(content) : null
    if (!url) { setImg(null); return }
    const i = new Image()
    i.onload = () => setImg({ url, w: i.naturalWidth, h: i.naturalHeight })
    i.src = url
  }, [content])
  return img
}

/** Shown under the properties of Sprite2D / AnimatedSprite2D / SpriteAnimation. */
export function SpriteTools({ inst }: { inst: Instance }) {
  useEditor()
  const sprite = inst.className === 'SpriteAnimation' ? inst.parent : inst
  if (!sprite || !(sprite.className === 'Sprite2D' || sprite.className === 'AnimatedSprite2D')) return null
  return (
    <div className="prop-group">
      <div className="prop-cat">Sprite sheet</div>
      <SheetGrid sprite={sprite} anim={inst.className === 'SpriteAnimation' ? inst : null} />
    </div>
  )
}

function SheetGrid({ sprite, anim }: { sprite: Instance; anim: Instance | null }) {
  const img = useImage(sprite.get<string>('Image'))
  const hf = Math.max(1, sprite.get<number>('HFrames') ?? 1), vf = Math.max(1, sprite.get<number>('VFrames') ?? 1)
  const frame = sprite.get<number>('Frame') ?? 0
  const animFrames = useMemo(() => (anim ? parseFrames(anim.get<string>('Frames')) : []), [anim, anim?.get('Frames')])
  const [preview, setPreview] = useState(true)
  const [tick, setTick] = useState(0)
  const fps = anim ? Math.max(0.5, anim.get<number>('FPS') ?? 8) : 0
  useEffect(() => {
    if (!anim || !preview || animFrames.length < 2) return
    const t = setInterval(() => setTick((x) => x + 1), 1000 / fps)
    return () => clearInterval(t)
  }, [anim, preview, fps, animFrames.length])

  if (!img) {
    return <div className="muted small pad">Set the <b>Image</b> property (import a PNG sprite sheet) to see its frames here.</div>
  }
  const cellW = img.w / hf, cellH = img.h / vf
  const scale = Math.min(4, Math.max(1, Math.floor(280 / img.w)))
  const playing = anim ? animFrames[tick % Math.max(1, animFrames.length)] : frame
  const mutate = (f: () => void) => (editor.playing ? f() : editor.mutate(f))

  const clickFrame = (i: number) => {
    if (anim) {
      // build the animation's frame list by clicking frames
      const list = animFrames.includes(i) ? animFrames.filter((x) => x !== i) : [...animFrames, i]
      mutate(() => anim.set('Frames', compress(list)))
    } else mutate(() => sprite.set('Frame', i))
  }

  return (
    <div className="sheet">
      <div className="sheet-grid" style={{ width: img.w * scale, height: img.h * scale, backgroundImage: `url("${img.url}")`, backgroundSize: `${img.w * scale}px ${img.h * scale}px` }}>
        {Array.from({ length: hf * vf }, (_, i) => {
          const inAnim = animFrames.includes(i)
          return (
            <button
              key={i}
              className={`sheet-cell${(!anim && i === frame) ? ' on' : ''}${inAnim ? ' in-anim' : ''}${anim && i === playing ? ' playing' : ''}`}
              style={{ left: (i % hf) * cellW * scale, top: Math.floor(i / hf) * cellH * scale, width: cellW * scale, height: cellH * scale }}
              title={anim ? `Frame ${i} — click to ${inAnim ? 'remove from' : 'add to'} "${anim.name}"` : `Frame ${i}`}
              onClick={() => clickFrame(i)}
            >
              <span>{i}</span>
            </button>
          )
        })}
      </div>
      <div className="sheet-info muted small">
        {img.w}×{img.h}px · {hf}×{vf} frames of {Math.round(cellW)}×{Math.round(cellH)}px
      </div>
      <div className="row-inline sheet-actions">
        <button className="btn small icon" title="Set Size to one frame" onClick={() => mutate(() => sprite.set('Size', new Vector2(Math.round(cellW), Math.round(cellH))))}>
          <Maximize size={12} /> Fit size to frame
        </button>
        {sprite.className === 'AnimatedSprite2D' && !anim && (
          <button className="btn small icon" onClick={() => editor.mutate(() => {
            const a = createInstance('SpriteAnimation')
            a.name = `anim${sprite.children.filter((c) => c.className === 'SpriteAnimation').length + 1}`
            a.set('Frames', `0-${hf * vf - 1}`)
            a.setParent(sprite)
            editor.selection = [a]
          })}><Plus size={12} /> Animation</button>
        )}
        {anim && (
          <button className="btn small icon" onClick={() => setPreview(!preview)}>{preview ? <Pause size={12} /> : <Play size={12} />} Preview</button>
        )}
      </div>
      {anim && (
        <div className="anim-preview">
          <div
            className="anim-frame"
            style={{
              width: cellW * scale * 2, height: cellH * scale * 2,
              backgroundImage: `url("${img.url}")`,
              backgroundSize: `${img.w * scale * 2}px ${img.h * scale * 2}px`,
              backgroundPosition: `-${(playing % hf) * cellW * scale * 2}px -${Math.floor(playing / hf) * cellH * scale * 2}px`,
            }}
          />
          <div className="muted small">"{anim.name}": frames {anim.get<string>('Frames') || '(none)'} at {fps} FPS{anim.get('Loop') ? ', looping' : ''}. Click frames above to add/remove them.</div>
        </div>
      )}
    </div>
  )
}

/** [0,1,2,3,7] -> "0-3, 7" */
function compress(list: number[]): string {
  const out: string[] = []
  for (let i = 0; i < list.length; i++) {
    let j = i
    while (j + 1 < list.length && list[j + 1] === list[j] + 1) j++
    out.push(j - i >= 2 ? `${list[i]}-${list[j]}` : list.slice(i, j + 1).join(', '))
    i = j
  }
  return out.join(', ')
}
