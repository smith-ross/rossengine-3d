// Values on the wire. Engine values are numbers/strings/booleans, datatypes (Vector3, CFrame…), Instances
// (sent as network ids: the host's instance id) and tables (Maps; arrays arrive as Maps with 1-based keys).
import { EnumItem, enumItem } from '../datatypes'
import { Instance, decodeValue, encodeValue } from '../instance'

export type RefOf = (i: Instance) => number | null
export type Resolve = (netId: number) => Instance | null

export function encodeNet(v: unknown, refOf: RefOf, depth = 0): unknown {
  if (v === undefined || v === null || typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') return v ?? null
  if (typeof v === 'function') return null
  if (depth > 32) return null
  if (v instanceof Map) return { t: 'M', v: [...v].map(([k, x]) => [encodeNet(k, refOf, depth + 1), encodeNet(x, refOf, depth + 1)]) }
  if (Array.isArray(v)) return { t: 'A', v: v.map((x) => encodeNet(x, refOf, depth + 1)) }
  const enc = encodeValue(v, refOf)
  if (enc !== v) return enc
  if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
    return { t: 'O', v: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, encodeNet(x, refOf, depth + 1)])) }
  }
  return null
}

export function decodeNet(v: unknown, resolve: Resolve): unknown {
  if (!v || typeof v !== 'object') return v
  const o = v as { t?: string; v?: unknown }
  switch (o.t) {
    case 'M': return new Map((o.v as Array<[unknown, unknown]>).map(([k, x]) => [decodeNet(k, resolve), decodeNet(x, resolve)]))
    case 'A': return (o.v as unknown[]).map((x) => decodeNet(x, resolve))
    case 'O': return new Map(Object.entries(o.v as object).map(([k, x]) => [k, decodeNet(x, resolve)]))
    default: return decodeValue(v, resolve, (e: string, n: string): EnumItem => enumItem(e, n))
  }
}

// ---- messages ------------------------------------------------------------------------------------
/** A replication op: create (parent, subtree), destroy, reparent, or property values. */
export type Op =
  | ['c', number, unknown] // parent netId, serialized subtree
  | ['d', number]
  | ['r', number, number] // netId, new parent netId
  | ['e', number, string, unknown[]] // remote netId, event name, args: a RemoteEvent firing in order with the ops

/** host -> client */
export type HostMsg =
  | { t: 'welcome'; player: number; snapshot: unknown; assets: unknown[]; name: string }
  | { t: 'reject'; reason: string }
  | { t: 'ops'; ops: Op[]; props: Array<[number, Record<string, unknown>]> }
  | { t: 'inv'; req: number; remote: number; args: unknown[] } // InvokeClient
  | { t: 'res'; req: number; ok: boolean; value: unknown } // answer to InvokeServer
  | { t: 'kick'; reason: string }

/** client -> host */
export type ClientMsg =
  | { t: 'hello'; name: string; version: number }
  | { t: 'up'; props: Array<[number, Record<string, unknown>]> } // the player's own character moved/changed
  | { t: 'ev'; remote: number; args: unknown[] } // FireServer
  | { t: 'inv'; req: number; remote: number; args: unknown[] } // InvokeServer
  | { t: 'res'; req: number; ok: boolean; value: unknown } // answer to InvokeClient

export const NET_VERSION = 1
