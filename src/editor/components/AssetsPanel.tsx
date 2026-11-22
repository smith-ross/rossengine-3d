import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import * as THREE from 'three'
import { FileAudio, Image as ImageIcon, Pause, Play, Plus, Search, Shapes, Trash2, Upload, Copy } from 'lucide-react'
import { Asset, AssetKind, assets, contentRef } from '../../engine/assets'
import { cloneMesh, loadMesh } from '../../engine/render/meshes'
import { editor, useEditor } from '../store'
import { formatBytes, importFiles, insertAsset, pickFiles, usagesOf } from '../assetOps'

export function useAssets() {
  useSyncExternalStore((fn) => assets.subscribe(fn), () => assets.version)
  return assets
}

export const ASSET_DRAG_TYPE = 'application/x-ross-asset'

export function AssetsPanel() {
  const ed = useEditor()
  useAssets()
  const [kind, setKind] = useState<AssetKind | 'all'>('all')
  const [q, setQ] = useState('')
  const [dragging, setDragging] = useState(false)
  const list = assets.list(kind === 'all' ? undefined : kind).filter((a) => !q || a.name.toLowerCase().includes(q.toLowerCase()))

  return (
    <div
      className={`assets${dragging ? ' drop' : ''}`}
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragging(true) } }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(false)
        void importFiles([...e.dataTransfer.files])
      }}
    >
      <div className="assets-bar">
        <button className="btn small icon" onClick={async () => importFiles(await pickFiles())}><Upload size={13} /> Import…</button>
        <div className="seg">
          {(['all', 'mesh', 'image', 'audio'] as const).map((k) => (
            <button key={k} className={kind === k ? 'on' : ''} onClick={() => setKind(k)}>
              {k === 'all' ? 'All' : k === 'mesh' ? 'Meshes' : k === 'image' ? 'Images' : 'Audio'}
            </button>
          ))}
        </div>
        <div className="search"><Search size={12} /><input placeholder="Search assets" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.stopPropagation()} /></div>
        <div className="spacer" />
        <span className="muted small">{assets.list().length} assets · {formatBytes(assets.totalBytes())}</span>
      </div>
      {list.length === 0 ? (
        <div className="assets-empty">
          <Upload size={22} />
          <div>Drop sound, image or 3D model files here, or click <b>Import…</b></div>
          <div className="muted small">.glb .gltf .obj .fbx .stl · .png .jpg .webp .gif .svg · .mp3 .ogg .wav</div>
        </div>
      ) : (
        <div className="asset-grid">
          {list.map((a) => <AssetTile key={a.id} asset={a} disabled={ed.playing} />)}
        </div>
      )}
    </div>
  )
}

function AssetTile({ asset, disabled }: { asset: Asset; disabled: boolean }) {
  const [renaming, setRenaming] = useState(false)
  const url = assets.url(contentRef(asset))
  return (
    <div
      className="asset-tile"
      draggable
      onDragStart={(e) => { e.dataTransfer.setData(ASSET_DRAG_TYPE, asset.id); e.dataTransfer.effectAllowed = 'copy' }}
      onDoubleClick={() => !disabled && insertAsset(asset)}
      title={`${asset.name}\n${asset.kind} · ${formatBytes(asset.bytes.length)}\nDrag into the viewport or double-click to insert.\nScripts: "asset://${asset.name}"`}
    >
      <div className="asset-thumb">
        {asset.kind === 'image' && url && <img src={url} alt="" />}
        {asset.kind === 'mesh' && <MeshThumb asset={asset} />}
        {asset.kind === 'audio' && <AudioThumb url={url} />}
        <span className={`asset-kind k-${asset.kind}`}>
          {asset.kind === 'mesh' ? <Shapes size={11} /> : asset.kind === 'image' ? <ImageIcon size={11} /> : <FileAudio size={11} />}
        </span>
      </div>
      {renaming ? (
        <input
          className="asset-rename"
          autoFocus
          defaultValue={asset.name}
          onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setRenaming(false) }}
          onBlur={(e) => { assets.rename(asset.id, e.target.value); setRenaming(false) }}
        />
      ) : (
        <div className="asset-name" onDoubleClick={(e) => { e.stopPropagation(); setRenaming(true) }}>{asset.name}</div>
      )}
      <div className="asset-actions">
        <button title="Insert into the place" disabled={disabled} onClick={() => insertAsset(asset)}><Plus size={13} /></button>
        <button title={`Copy "asset://${asset.name}" for scripts`} onClick={() => { void navigator.clipboard?.writeText(`asset://${asset.name}`); editor.log('system', `Copied asset://${asset.name}`) }}><Copy size={13} /></button>
        <button
          title="Delete asset"
          disabled={disabled}
          onClick={() => {
            const used = usagesOf(asset)
            const msg = used.length
              ? `"${asset.name}" is used by ${used.length} object(s) (${used.slice(0, 3).map((u) => u.name).join(', ')}${used.length > 3 ? '…' : ''}). Delete anyway?`
              : `Delete "${asset.name}"?`
            if (window.confirm(msg)) assets.remove(asset.id)
          }}
        ><Trash2 size={13} /></button>
      </div>
    </div>
  )
}

function AudioThumb({ url }: { url: string | null }) {
  const audio = useMemo(() => (url ? new Audio(url) : null), [url])
  const [playing, setPlaying] = useState(false)
  useEffect(() => {
    if (!audio) return
    const end = () => setPlaying(false)
    audio.addEventListener('ended', end)
    return () => { audio.pause(); audio.removeEventListener('ended', end) }
  }, [audio])
  return (
    <button
      className="audio-btn"
      onClick={(e) => {
        e.stopPropagation()
        if (!audio) return
        if (playing) { audio.pause(); audio.currentTime = 0; setPlaying(false) } else { void audio.play(); setPlaying(true) }
      }}
    >
      {playing ? <Pause size={22} /> : <Play size={22} />}
    </button>
  )
}

// ---- mesh thumbnails: rendered once with a shared offscreen renderer ----------
const thumbCache = new Map<string, Promise<string | null>>()
let thumbRenderer: THREE.WebGLRenderer | null = null

function renderThumb(asset: Asset): Promise<string | null> {
  let p = thumbCache.get(asset.id)
  if (p) return p
  p = loadMesh(contentRef(asset)).then((m) => {
    if (!m) return null
    if (!thumbRenderer) {
      thumbRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true })
      thumbRenderer.setSize(128, 128)
      thumbRenderer.outputColorSpace = THREE.SRGBColorSpace
    }
    const scene = new THREE.Scene()
    scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 2.2))
    const sun = new THREE.DirectionalLight(0xffffff, 2)
    sun.position.set(2, 3, 2)
    scene.add(sun)
    const obj = cloneMesh(m)
    // undo normalization so the preview keeps the model's proportions
    const s = m.naturalSize
    const max = Math.max(s.x, s.y, s.z) || 1
    obj.scale.set(s.x / max, s.y / max, s.z / max)
    if (!m.hasTextures) obj.traverse((o) => { const mm = o as THREE.Mesh; if (mm.isMesh) mm.material = new THREE.MeshStandardMaterial({ color: 0xc8ccd4, roughness: 0.6 }) })
    scene.add(obj)
    const cam = new THREE.PerspectiveCamera(35, 1, 0.01, 100)
    cam.position.set(1.4, 1.1, 1.6)
    cam.lookAt(0, 0, 0)
    thumbRenderer.render(scene, cam)
    return thumbRenderer.domElement.toDataURL('image/png')
  })
  thumbCache.set(asset.id, p)
  return p
}

function MeshThumb({ asset }: { asset: Asset }) {
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => { let alive = true; void renderThumb(asset).then((s) => alive && setSrc(s)); return () => { alive = false } }, [asset])
  return src ? <img src={src} alt="" /> : <Shapes size={26} className="muted" />
}
