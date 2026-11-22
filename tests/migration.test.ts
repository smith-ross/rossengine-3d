import { describe, it, expect } from 'vitest'
import '../src/engine/classes'
import { DataModel } from '../src/engine/classes'
import { deserialize } from '../src/engine/instance'

describe('place migration', () => {
  it('maps client/server classes onto the single-script model', () => {
    const old = {
      className: 'DataModel', ref: 1, props: { Name: 'Game' }, children: [
        { className: 'ServerScriptService', ref: 2, props: { Name: 'ServerScriptService' }, children: [
          { className: 'Script', ref: 3, props: { Name: 'Main', Source: 'print(1)', Enabled: true }, children: [] },
        ] },
        { className: 'ReplicatedStorage', ref: 4, props: { Name: 'ReplicatedStorage' }, children: [
          { className: 'ModuleScript', ref: 5, props: { Name: 'Util', Source: 'return {}' }, children: [] },
        ] },
        { className: 'StarterPlayer', ref: 6, props: { Name: 'StarterPlayer' }, children: [
          { className: 'StarterPlayerScripts', ref: 7, props: { Name: 'StarterPlayerScripts' }, children: [
            { className: 'LocalScript', ref: 8, props: { Name: 'Client', Source: 'print(2)', Enabled: true }, children: [] },
          ] },
        ] },
      ],
    }
    const g = new DataModel()
    deserialize(old as any, g)
    g.initServices()
    const ss = g.getService('ScriptService')
    expect(ss.children.map((c) => `${c.className}:${c.name}`).sort()).toEqual(['Script:Client', 'Script:Main'])
    expect(g.getService('Storage').findFirstChild('Util')?.className).toBe('ModuleScript')
    expect(g.getService('ReplicatedStorage')).toBe(g.getService('Storage'))
    expect(g.getService('StarterPlayer').findFirstChild('StarterPlayerScripts')).toBeNull()
  })
})
