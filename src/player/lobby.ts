// The Host / Join screen a multiplayer game shows before it starts (NetworkService.Enabled).
export type LobbyChoice = { mode: 'solo'; name: string } | { mode: 'host'; name: string } | { mode: 'join'; name: string; address: string }

const remember = (key: string, value?: string) => {
  try {
    if (value === undefined) return localStorage.getItem(`ross-lobby:${key}`) ?? ''
    localStorage.setItem(`ross-lobby:${key}`, value)
  } catch { /* storage unavailable */ }
  return ''
}

const css = `
.ross-lobby { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; z-index: 100;
  background: radial-gradient(circle at 50% 30%, #1d2533, #0b0d12); font: 14px system-ui, 'Segoe UI', sans-serif; color: #e6e8ee; }
.ross-lobby .card { width: min(420px, calc(100vw - 32px)); background: #171b24; border: 1px solid #2a3140; border-radius: 12px; padding: 24px; box-shadow: 0 20px 60px rgba(0,0,0,.5); }
.ross-lobby h1 { margin: 0 0 4px; font-size: 22px; }
.ross-lobby .sub { margin: 0 0 18px; color: #9aa3b2; }
.ross-lobby label { display: block; margin: 12px 0 4px; color: #9aa3b2; font-size: 12px; }
.ross-lobby input { width: 100%; box-sizing: border-box; padding: 9px 10px; border-radius: 7px; border: 1px solid #333c4d; background: #0f131a; color: inherit; font: inherit; }
.ross-lobby .row { display: flex; gap: 8px; margin-top: 8px; }
.ross-lobby button { flex: 1; padding: 10px 12px; border-radius: 7px; border: 1px solid #333c4d; background: #222a38; color: inherit; font: inherit; font-weight: 600; cursor: pointer; }
.ross-lobby button:hover:not(:disabled) { border-color: #4aa3ff; }
.ross-lobby button.primary { background: #2b78d0; border-color: #2b78d0; }
.ross-lobby button:disabled { opacity: .5; cursor: default; }
.ross-lobby .err { min-height: 18px; margin-top: 12px; color: #ff8a8a; }
.ross-lobby .note { margin-top: 14px; color: #7d8696; font-size: 12px; }
`

export interface Lobby {
  /** wait for the player to pick */
  choose(): Promise<LobbyChoice>
  /** show a problem (e.g. could not join) and let them pick again */
  error(msg: string): void
  busy(msg: string): void
  close(): void
}

export function createLobby(title: string, port: number, canNetwork: boolean): Lobby {
  const style = document.createElement('style')
  style.textContent = css
  const root = document.createElement('div')
  root.className = 'ross-lobby'
  root.innerHTML = `
    <div class="card">
      <h1></h1>
      <p class="sub">Play together: one player hosts, the others join.</p>
      <label>Your name</label>
      <input class="name" maxlength="20" placeholder="Player" />
      <div class="row"><button class="host primary">Host a game</button></div>
      <label>Join a game at</label>
      <div class="row" style="margin-top:0"><input class="addr" placeholder="192.168.1.20:${port}" /><button class="join" style="flex:0 0 90px">Join</button></div>
      <div class="row"><button class="solo">Play alone</button></div>
      <div class="err"></div>
      <div class="note"></div>
    </div>`
  root.querySelector('h1')!.textContent = title
  const name = root.querySelector<HTMLInputElement>('.name')!
  const addr = root.querySelector<HTMLInputElement>('.addr')!
  const err = root.querySelector<HTMLDivElement>('.err')!
  const note = root.querySelector<HTMLDivElement>('.note')!
  const buttons = [...root.querySelectorAll('button')]
  name.value = remember('name') || 'Player'
  addr.value = remember('address')
  note.textContent = canNetwork
    ? `Hosting uses port ${port}. Players on other networks need it forwarded on the host's router; Windows may ask to allow the game through the firewall.`
    : 'Hosting and joining need the desktop version of this game.'
  if (!canNetwork) for (const b of buttons) if (!b.classList.contains('solo')) b.disabled = true
  document.head.appendChild(style)
  document.body.appendChild(root)

  let pick: ((c: LobbyChoice) => void) | null = null
  const choose = (c: LobbyChoice) => { if (pick) { const p = pick; pick = null; p(c) } }
  const who = () => { const n = name.value.trim().replace(/[^\w\- ]/g, '').slice(0, 20) || 'Player'; remember('name', n); return n }
  root.querySelector<HTMLButtonElement>('.host')!.onclick = () => choose({ mode: 'host', name: who() })
  root.querySelector<HTMLButtonElement>('.solo')!.onclick = () => choose({ mode: 'solo', name: who() })
  const join = () => {
    const a = addr.value.trim()
    if (!a) { err.textContent = 'Type the address the host sees on their screen.'; addr.focus(); return }
    remember('address', a)
    choose({ mode: 'join', name: who(), address: a })
  }
  root.querySelector<HTMLButtonElement>('.join')!.onclick = join
  addr.onkeydown = (e) => { if (e.key === 'Enter') join() }

  return {
    choose: () => {
      for (const b of buttons) b.disabled = !canNetwork && !b.classList.contains('solo')
      return new Promise((resolve) => { pick = resolve })
    },
    error: (msg) => { err.style.color = '#ff8a8a'; err.textContent = msg },
    busy: (msg) => { err.style.color = '#9aa3b2'; err.textContent = msg; for (const b of buttons) b.disabled = true },
    close: () => { root.remove(); style.remove() },
  }
}

/** A note over the game for a while (e.g. the address others join with). */
export function banner(text: string, ms = 15000) {
  const b = document.createElement('div')
  Object.assign(b.style, {
    position: 'fixed', top: '12px', left: '50%', transform: 'translateX(-50%)', zIndex: '90', padding: '8px 14px',
    background: 'rgba(20,26,36,0.9)', color: '#e6e8ee', border: '1px solid #2b78d0', borderRadius: '8px',
    font: '600 13px system-ui, sans-serif', pointerEvents: 'none', transition: 'opacity .6s',
  })
  b.textContent = text
  document.body.appendChild(b)
  setTimeout(() => { b.style.opacity = '0'; setTimeout(() => b.remove(), 700) }, ms)
}
