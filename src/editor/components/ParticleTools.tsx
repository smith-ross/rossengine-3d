// Properties-panel tools for ParticleEmitter / ParticleEmitter2D: ready-made looks and a test burst.
import { Sparkles, Trash2 } from 'lucide-react'
import { Instance } from '../../engine/instance'
import { PARTICLE_PRESETS, applyParticlePreset, emitterMethods } from '../../engine/particleClasses'
import { editor, useEditor } from '../store'

export function ParticleTools({ inst }: { inst: Instance }) {
  const ed = useEditor()
  const readOnly = ed.playing && inst.dataModel === editor.game
  return (
    <div className="prop-group">
      <div className="prop-cat">Particle presets</div>
      <div className="particle-tools">
        <div className="particle-presets">
          {Object.entries(PARTICLE_PRESETS).map(([key, p]) => (
            <button key={key} disabled={readOnly} title={`Set this emitter up as ${p.label.toLowerCase()} (keeps its Texture)`}
              onClick={() => editor.mutate(() => applyParticlePreset(inst, key))}>{p.label}</button>
          ))}
        </div>
        <div className="particle-actions">
          <button title="Shoot out 20 particles now, like Emit(20) from a script" onClick={() => emitterMethods.Emit(inst, 20)}><Sparkles size={13} /> Emit 20</button>
          <button title="Remove the particles that are out now, like Clear() from a script" onClick={() => emitterMethods.Clear(inst)}><Trash2 size={13} /> Clear</button>
        </div>
      </div>
    </div>
  )
}
