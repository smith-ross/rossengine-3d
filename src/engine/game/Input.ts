// Keyboard code -> Enum.KeyCode name mapping.
const special: Record<string, string> = {
  Space: 'Space', Enter: 'Return', NumpadEnter: 'Return', Escape: 'Escape', Tab: 'Tab', Backspace: 'Backspace',
  ShiftLeft: 'LeftShift', ShiftRight: 'RightShift', ControlLeft: 'LeftControl', ControlRight: 'RightControl',
  AltLeft: 'LeftAlt', AltRight: 'RightAlt', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
}
const digits = ['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine']

export function keyCodeName(code: string): string {
  if (code.startsWith('Key') && code.length === 4) return code.slice(3)
  if (code.startsWith('Digit')) return digits[Number(code.slice(5))] ?? 'Unknown'
  if (/^F\d{1,2}$/.test(code)) return code
  return special[code] ?? 'Unknown'
}

/**
 * Right-drag camera look: locks the cursor in place while the button is held (like Roblox),
 * reports movement deltas, and releases it on mouse-up. Without pointer lock support the drag
 * still works from cursor positions.
 */
export class DragLook {
  private active = false
  private last: { x: number; y: number } | null = null
  private skipFirst = false
  private onLockChange = () => {
    // lock lost mid-drag (Esc, alt-tab): end the drag so the camera doesn't keep turning
    if (this.active && document.pointerLockElement !== this.el && this.locked) this.end()
    this.locked = document.pointerLockElement === this.el
  }
  private locked = false

  constructor(private el: HTMLElement) {
    document.addEventListener('pointerlockchange', this.onLockChange)
  }

  get dragging() { return this.active }

  begin(e: MouseEvent) {
    this.active = true
    this.last = { x: e.clientX, y: e.clientY }
    this.skipFirst = true
    try {
      const p = this.el.requestPointerLock?.() as unknown as Promise<void> | undefined
      p?.catch?.(() => {}) // denied or too soon after Esc: fall back to cursor positions
    } catch { /* unsupported */ }
  }

  /** Mouse movement since the last event while dragging, or null when not dragging. */
  move(e: MouseEvent): { dx: number; dy: number } | null {
    if (!this.active) return null
    let dx: number, dy: number
    if (document.pointerLockElement === this.el) {
      dx = e.movementX; dy = e.movementY
      // Chromium on Windows can report one bogus jump right after locking
      if (this.skipFirst && Math.abs(dx) + Math.abs(dy) > 150) { this.skipFirst = false; return { dx: 0, dy: 0 } }
      this.skipFirst = false
    } else {
      dx = e.clientX - this.last!.x; dy = e.clientY - this.last!.y
      this.last = { x: e.clientX, y: e.clientY }
    }
    return { dx, dy }
  }

  end() {
    this.active = false
    this.last = null
    if (document.pointerLockElement === this.el) document.exitPointerLock()
  }

  dispose() {
    this.end()
    document.removeEventListener('pointerlockchange', this.onLockChange)
  }
}
