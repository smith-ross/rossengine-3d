// Live preview for the visual shader editor: a lit sphere (3D), the sprite's own image (2D), or a
// sample scene run through the screen shader.
import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { Instance } from '../../engine/instance'
import { Color3, Vector2 } from '../../engine/datatypes'
import { assets } from '../../engine/assets'
import { attributeUniforms, baseUniforms, buildShader, clock, ShaderKind, updateShaderUniforms, ShaderMat } from '../../engine/render/shaders'

interface Stage {
  renderer: THREE.WebGLRenderer
  scene: THREE.Scene
  camera: THREE.Camera
  mesh: THREE.Mesh
  sm: ShaderMat | null
  raf: number
}

/** A small painted landscape: something for screen effects to work on. */
function sampleScreen(): THREE.Texture {
  const c = document.createElement('canvas')
  c.width = 480; c.height = 270
  const g = c.getContext('2d')!
  const sky = g.createLinearGradient(0, 0, 0, 200)
  sky.addColorStop(0, '#3a7bd5'); sky.addColorStop(1, '#a8d8ff')
  g.fillStyle = sky; g.fillRect(0, 0, 480, 270)
  g.fillStyle = '#fff3b0'; g.beginPath(); g.arc(380, 60, 28, 0, Math.PI * 2); g.fill()
  g.fillStyle = '#5aa05a'; g.beginPath(); g.moveTo(0, 190); g.quadraticCurveTo(120, 120, 240, 185); g.quadraticCurveTo(360, 130, 480, 180); g.lineTo(480, 270); g.lineTo(0, 270); g.fill()
  g.fillStyle = '#3d7d3d'; g.fillRect(0, 220, 480, 50)
  const boxes: Array<[number, number, number, string]> = [[70, 175, 40, '#e85d5d'], [130, 190, 28, '#f2c94c'], [300, 170, 46, '#9b6bdf'], [360, 192, 26, '#4ecdc4']]
  for (const [x, y, s, col] of boxes) { g.fillStyle = col; g.fillRect(x, y, s, s); g.fillStyle = 'rgba(0,0,0,0.25)'; g.fillRect(x, y + s - 6, s, 6) }
  g.fillStyle = '#ffffff'; g.font = 'bold 22px "Segoe UI", sans-serif'; g.fillText('Preview', 18, 36)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}

function linear(c: Color3 | undefined) {
  const v = new THREE.Color(1, 1, 1)
  if (c) v.setRGB(c.r, c.g, c.b, THREE.SRGBColorSpace)
  return v
}

export function ShaderPreview({ shader, source, kind, transparent }: { shader: Instance; source: string; kind: ShaderKind; transparent: boolean }) {
  const host = useRef<HTMLDivElement>(null)
  const stage = useRef<Stage | null>(null)

  // renderer + scene (once per kind)
  useEffect(() => {
    const el = host.current!
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.toneMapping = kind === '3d' ? THREE.ACESFilmicToneMapping : THREE.NoToneMapping
    renderer.debug.onShaderError = () => {} // recipes always compile; hand-written errors show in the code editor
    el.appendChild(renderer.domElement)
    const scene = new THREE.Scene()
    let camera: THREE.Camera
    let mesh: THREE.Mesh
    if (kind === '3d') {
      const cam = new THREE.PerspectiveCamera(35, 1, 0.1, 20)
      cam.position.set(0, 0.35, 2.4); cam.lookAt(0, 0, 0)
      camera = cam
      mesh = new THREE.Mesh(new THREE.SphereGeometry(0.5, 96, 64))
    } else {
      camera = new THREE.OrthographicCamera(-0.5, 0.5, 0.5, -0.5, -1, 1)
      mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1))
    }
    scene.add(mesh)
    const st: Stage = { renderer, scene, camera, mesh, sm: null, raf: 0 }
    stage.current = st
    const resize = () => {
      const w = el.clientWidth || 1, h = el.clientHeight || 1
      renderer.setSize(w, h)
      if (camera instanceof THREE.PerspectiveCamera) { camera.aspect = w / h; camera.updateProjectionMatrix() }
      else if (camera instanceof THREE.OrthographicCamera) {
        const a = w / h
        if (kind === 'screen') { camera.left = -0.5; camera.right = 0.5; camera.top = 0.5; camera.bottom = -0.5; mesh.scale.set(1, 1, 1) }
        else { camera.left = -0.5 * a; camera.right = 0.5 * a; camera.top = 0.5; camera.bottom = -0.5 }
        camera.updateProjectionMatrix()
      }
    }
    const ro = new ResizeObserver(resize)
    ro.observe(el)
    resize()
    const loop = () => {
      st.raf = requestAnimationFrame(loop)
      if (kind === '3d') mesh.rotation.y += 0.004
      const sm = st.sm
      if (sm) {
        updateShaderUniforms(sm, clock())
        sm.material.uniforms.RESOLUTION.value.copy(renderer.getDrawingBufferSize(new THREE.Vector2()))
        const map = sm.material.uniforms.TEXTURE.value as THREE.Texture | null
        if (map && kind !== 'screen') { map.updateMatrix(); sm.material.uniforms.UV_TRANSFORM.value.copy(map.matrix) }
      }
      renderer.render(scene, camera)
    }
    st.raf = requestAnimationFrame(loop)
    return () => {
      cancelAnimationFrame(st.raf)
      ro.disconnect()
      st.sm?.material.dispose()
      mesh.geometry.dispose()
      renderer.dispose()
      renderer.domElement.remove()
      stage.current = null
    }
  }, [kind])

  // material: rebuilt when the generated GLSL (or the object's look) changes
  const parent = shader.parent
  const image = parent?.get<string>('Image') || parent?.get<string>('TileSet') || ''
  const colorKey = JSON.stringify(parent?.get<Color3>('Color') ?? null)
  const uniformKey = attributeUniforms(shader).map((u) => u.join(':')).join(',')
  useEffect(() => {
    const st = stage.current
    if (!st) return
    const uniforms = attributeUniforms(shader)
    const built = buildShader(source, kind, uniforms, 'preview')
    const vertexShader = built.vertexShader
    // in the game, screen passes run before the output pass (linear -> sRGB); here they draw straight to the canvas
    const fragmentShader = kind === 'screen'
      ? built.fragmentShader.replace('gl_FragColor = fragment();', 'gl_FragColor = fragment();\n\tgl_FragColor.rgb = pow(max(gl_FragColor.rgb, 0.0), vec3(1.0 / 2.2));')
      : built.fragmentShader
    const material = new THREE.ShaderMaterial({
      vertexShader, fragmentShader,
      uniforms: { ...baseUniforms(kind), ...Object.fromEntries(uniforms.map(([n]) => [n, { value: null }])) },
      transparent: transparent || kind === '2d',
      depthWrite: !transparent && kind === '3d',
      side: kind === '3d' ? THREE.FrontSide : THREE.DoubleSide,
    })
    const u = material.uniforms
    if (kind === 'screen') {
      u.TEXTURE.value = sampleScreen()
    } else {
      const c = linear(parent?.get<Color3>('Color'))
      u.COLOR.value.set(c.r, c.g, c.b, 1 - (parent?.get<number>('Transparency') ?? 0))
      if (kind === '2d' && image && assets.url(image)) {
        const tex = new THREE.TextureLoader().load(assets.url(image)!, (t) => {
          // keep the sprite's proportions (one frame of a sheet)
          const img = t.image as HTMLImageElement
          const hf = Math.max(1, parent?.get<number>('HFrames') ?? 1), vf = Math.max(1, parent?.get<number>('VFrames') ?? 1)
          const size = parent?.get<Vector2>('Size')
          const aspect = size && size.y ? size.x / size.y : img.width / hf / (img.height / vf)
          st.mesh.scale.set(Math.min(0.85, 0.85 * aspect), Math.min(0.85, 0.85 / aspect), 1)
        })
        tex.colorSpace = THREE.SRGBColorSpace
        tex.magFilter = THREE.NearestFilter
        tex.minFilter = THREE.NearestFilter
        const hf = Math.max(1, parent?.get<number>('HFrames') ?? 1), vf = Math.max(1, parent?.get<number>('VFrames') ?? 1)
        tex.repeat.set(1 / hf, 1 / vf)
        tex.offset.set(0, 1 - 1 / vf)
        u.TEXTURE.value = tex
        u.HAS_TEXTURE.value = true
      } else if (kind === '2d') st.mesh.scale.set(0.7, 0.7, 1)
    }
    const prev = st.sm
    st.sm = { shader, material, key: source, uniforms }
    st.mesh.material = material
    if (prev) { (prev.material.uniforms.TEXTURE?.value as THREE.Texture | null)?.dispose(); prev.material.dispose() }
  }, [source, kind, transparent, image, colorKey, uniformKey, shader, parent])

  return <div ref={host} className={`vs-preview${kind === '2d' ? ' checker' : ''}`} />
}
