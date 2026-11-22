// Procedurally generated tileable textures for part materials (no external assets).
import * as THREE from 'three'

const cache = new Map<string, THREE.Texture | null>()

function rand(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function canvasTexture(size: number, draw: (ctx: CanvasRenderingContext2D, r: () => number) => void) {
  if (typeof document === 'undefined') return null
  const c = document.createElement('canvas')
  c.width = c.height = size
  const ctx = c.getContext('2d')!
  draw(ctx, rand(1234))
  const tex = new THREE.CanvasTexture(c)
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.colorSpace = THREE.NoColorSpace // treat as linear multiplier so colors stay bright
  tex.anisotropy = 4
  return tex
}

function noise(ctx: CanvasRenderingContext2D, r: () => number, size: number, amount: number, base = 235) {
  const img = ctx.createImageData(size, size)
  for (let i = 0; i < size * size; i++) {
    const v = base + (r() - 0.5) * amount
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v
    img.data[i * 4 + 3] = 255
  }
  ctx.putImageData(img, 0, 0)
}

export function materialTexture(material: string): THREE.Texture | null {
  if (cache.has(material)) return cache.get(material)!
  let tex: THREE.Texture | null = null
  switch (material) {
    case 'Plastic':
      // subtle studs-free speckle
      tex = canvasTexture(64, (ctx, r) => noise(ctx, r, 64, 14, 245))
      break
    case 'Grass':
      tex = canvasTexture(128, (ctx, r) => {
        noise(ctx, r, 128, 50, 215)
        for (let i = 0; i < 500; i++) {
          ctx.fillStyle = `rgba(255,255,255,${r() * 0.25})`
          ctx.fillRect(r() * 128, r() * 128, 1, 2 + r() * 3)
        }
      })
      break
    case 'Concrete': case 'Slate': case 'Sand':
      tex = canvasTexture(128, (ctx, r) => noise(ctx, r, 128, material === 'Sand' ? 40 : 60, 215))
      break
    case 'Wood':
      tex = canvasTexture(128, (ctx, r) => {
        ctx.fillStyle = '#e6e6e6'
        ctx.fillRect(0, 0, 128, 128)
        for (let y = 0; y < 128; y += 2) {
          const v = 200 + Math.sin(y * 0.3 + r() * 0.5) * 25 + r() * 15
          ctx.fillStyle = `rgb(${v},${v},${v})`
          ctx.fillRect(0, y, 128, 2)
        }
      })
      break
    case 'Brick':
      tex = canvasTexture(128, (ctx, r) => {
        ctx.fillStyle = '#bcbcbc'
        ctx.fillRect(0, 0, 128, 128)
        for (let row = 0; row < 4; row++) for (let col = -1; col < 3; col++) {
          const x = col * 64 + (row % 2 ? 32 : 0)
          const v = 225 + r() * 30
          ctx.fillStyle = `rgb(${v},${v},${v})`
          ctx.fillRect(x + 2, row * 32 + 2, 60, 28)
        }
      })
      break
    case 'Metal':
      tex = canvasTexture(128, (ctx, r) => {
        noise(ctx, r, 128, 10, 230)
        for (let i = 0; i < 128; i++) {
          ctx.fillStyle = `rgba(255,255,255,${r() * 0.15})`
          ctx.fillRect(0, i, 128, 1)
        }
      })
      break
    case 'Fabric':
      tex = canvasTexture(64, (ctx) => {
        ctx.fillStyle = '#e0e0e0'
        ctx.fillRect(0, 0, 64, 64)
        ctx.fillStyle = '#f5f5f5'
        for (let i = 0; i < 64; i += 4) { ctx.fillRect(i, 0, 2, 64); ctx.fillRect(0, i, 64, 1) }
      })
      break
  }
  cache.set(material, tex)
  return tex
}
