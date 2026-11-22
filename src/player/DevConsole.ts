// F9 developer console for the standalone player (like Roblox's).
import type { OutputKind } from '../engine/luau/LuauRuntime'

export class DevConsole {
  private el: HTMLDivElement
  private list: HTMLDivElement
  private errors = 0
  private badge: HTMLDivElement

  constructor(parent: HTMLElement) {
    this.el = document.createElement('div')
    Object.assign(this.el.style, {
      position: 'absolute', left: '10%', right: '10%', bottom: '10%', top: '10%', display: 'none', zIndex: '1000',
      background: 'rgba(20,22,28,0.94)', color: '#ddd', borderRadius: '8px', font: '13px Consolas, monospace',
      flexDirection: 'column', boxShadow: '0 10px 40px rgba(0,0,0,.5)',
    })
    const head = document.createElement('div')
    head.textContent = 'Developer Console (F9)'
    Object.assign(head.style, { padding: '8px 12px', borderBottom: '1px solid #333', fontWeight: 'bold' })
    this.list = document.createElement('div')
    Object.assign(this.list.style, { flex: '1', overflow: 'auto', padding: '8px 12px', whiteSpace: 'pre-wrap' })
    this.el.append(head, this.list)
    this.badge = document.createElement('div')
    Object.assign(this.badge.style, {
      position: 'absolute', right: '12px', bottom: '12px', padding: '4px 10px', borderRadius: '12px', zIndex: '999',
      background: 'rgba(200,40,40,.85)', color: '#fff', font: '12px Segoe UI, sans-serif', display: 'none', cursor: 'pointer',
    })
    this.badge.onclick = () => this.toggle(true)
    parent.append(this.el, this.badge)
    window.addEventListener('keydown', (e) => { if (e.key === 'F9') this.toggle() })
  }

  toggle(force?: boolean) {
    const show = force ?? this.el.style.display === 'none'
    this.el.style.display = show ? 'flex' : 'none'
  }

  log(kind: OutputKind, msg: string, source?: string) {
    const line = document.createElement('div')
    const time = new Date().toLocaleTimeString()
    line.textContent = `${time}  ${source && kind === 'error' ? '' : ''}${msg}`
    line.style.color = kind === 'error' ? '#ff6b6b' : kind === 'warn' ? '#ffb347' : '#ddd'
    this.list.appendChild(line)
    this.list.scrollTop = this.list.scrollHeight
    ;(kind === 'error' ? console.error : kind === 'warn' ? console.warn : console.log)(msg)
    if (kind === 'error') {
      this.errors++
      this.badge.textContent = `${this.errors} error${this.errors > 1 ? 's' : ''} — press F9`
      this.badge.style.display = 'block'
    }
  }
}
