import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { DragLook } from '../src/engine/game/Input'

// Minimal stand-in for the browser's Pointer Lock API (tests run in Node).
type Listener = () => void
let doc: { pointerLockElement: unknown; listeners: Listener[]; addEventListener: (t: string, f: Listener) => void; removeEventListener: (t: string, f: Listener) => void; exitPointerLock: () => void }
const change = () => doc.listeners.forEach((f) => f())
const makeEl = (grant = true) => {
  const el = {
    requestPointerLock: () => {
      if (!grant) return Promise.reject(new Error('denied'))
      doc.pointerLockElement = el
      change()
      return Promise.resolve()
    },
  }
  return el as unknown as HTMLElement
}
const ev = (clientX: number, clientY: number, movementX = 0, movementY = 0) => ({ clientX, clientY, movementX, movementY }) as MouseEvent

beforeEach(() => {
  doc = {
    pointerLockElement: null,
    listeners: [],
    addEventListener: (_t, f) => doc.listeners.push(f),
    removeEventListener: (_t, f) => { doc.listeners = doc.listeners.filter((x) => x !== f) },
    exitPointerLock: () => { doc.pointerLockElement = null; change() },
  }
  ;(globalThis as any).document = doc
})
afterEach(() => { delete (globalThis as any).document })

describe('DragLook (right-drag camera)', () => {
  it('locks the cursor while dragging and turns by raw mouse movement', () => {
    const el = makeEl()
    const look = new DragLook(el)
    look.begin(ev(400, 300))
    expect(doc.pointerLockElement).toBe(el)
    // locked: clientX/Y stay put, movement comes from movementX/Y
    expect(look.move(ev(400, 300, 12, -5))).toEqual({ dx: 12, dy: -5 })
    expect(look.move(ev(400, 300, 3, 4))).toEqual({ dx: 3, dy: 4 })
    look.end()
    expect(doc.pointerLockElement).toBe(null)
    expect(look.move(ev(400, 300, 5, 5))).toBe(null)
    look.dispose()
  })

  it('ignores the bogus jump some browsers report right after locking', () => {
    const look = new DragLook(makeEl())
    look.begin(ev(400, 300))
    expect(look.move(ev(400, 300, 900, -600))).toEqual({ dx: 0, dy: 0 })
    expect(look.move(ev(400, 300, 900, -600))).toEqual({ dx: 900, dy: -600 }) // later fast flicks are real
    look.dispose()
  })

  it('falls back to cursor positions when the lock is refused', async () => {
    const look = new DragLook(makeEl(false))
    look.begin(ev(400, 300))
    await Promise.resolve()
    expect(doc.pointerLockElement).toBe(null)
    expect(look.move(ev(410, 296))).toEqual({ dx: 10, dy: -4 })
    expect(look.move(ev(415, 296))).toEqual({ dx: 5, dy: 0 })
    look.dispose()
  })

  it('ends the drag when the lock is lost mid-drag (Esc, alt-tab)', () => {
    const look = new DragLook(makeEl())
    look.begin(ev(400, 300))
    doc.pointerLockElement = null
    change()
    expect(look.dragging).toBe(false)
    expect(look.move(ev(400, 300, 10, 0))).toBe(null)
    look.dispose()
  })
})
