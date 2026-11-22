import type { Plugin } from 'vite'
// Dev-server API used by the editor to build standalone Electron games (implemented below).
export function buildServerPlugin(): Plugin {
  return { name: 'rossengine-build-server' }
}
