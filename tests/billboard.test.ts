import { describe, it, expect } from 'vitest'
import '../src/engine/classes'
import { createInstance } from '../src/engine/instance'
import { UDim2, Vector3 } from '../src/engine/datatypes'
import { billboardBox } from '../src/engine/gui/BillboardLayer'

describe('BillboardGui', () => {
  it('is a GUI container with world-sized defaults', () => {
    const bb = createInstance('BillboardGui')
    expect(bb.isA('LayerCollector')).toBe(true)
    expect(bb.get<UDim2>('Size').xs).toBe(4) // 4 x 1 studs
    expect(bb.get<boolean>('Enabled')).toBe(true)
    expect(bb.get<boolean>('AlwaysOnTop')).toBe(false)
    expect(bb.get<Vector3>('StudsOffset').magnitude).toBe(0)
    expect(bb.get('Adornee')).toBeNull()
  })

  it('sizes in studs grow and shrink with distance; sizes in pixels stay put', () => {
    // 4 x 1 studs, seen where a stud is 30 pixels: 120 x 30 on screen
    const near = billboardBox(new UDim2(4, 0, 1, 0), 30, '3d')
    expect(near.w * near.scale).toBeCloseTo(120)
    expect(near.h * near.scale).toBeCloseTo(30)
    const far = billboardBox(new UDim2(4, 0, 1, 0), 10, '3d')
    expect(far.w * far.scale).toBeCloseTo(40)
    // pixels only: the same size at any distance
    for (const unitPx of [5, 50]) {
      const b = billboardBox(new UDim2(0, 200, 0, 50), unitPx, '3d')
      expect([b.w * b.scale, b.h * b.scale]).toEqual([200, 50])
    }
    // 2D: scale is in world pixels, times the zoom
    const z = billboardBox(new UDim2(64, 0, 16, 0), 2, '2d')
    expect([z.w * z.scale, z.h * z.scale]).toEqual([128, 32])
  })
})
