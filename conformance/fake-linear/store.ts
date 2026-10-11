/**
 * In-memory Linear workspace state.
 *
 * Records keep GraphQL field names. A field whose schema type is an entity
 * stores the referenced ID (or an array of IDs); connections are derived by
 * the resolver from those references. Nothing here knows which queries the CLI
 * under test sends.
 */

export interface EntityRecord {
  id: string
  __typename: string
  [field: string]: unknown
}

export type Seed = Record<string, Record<string, unknown>[]>

import { expandRepeats, withDefaults } from "./defaults.ts"

/** The world's current time; writes count up from it. */
export const WORLD_NOW = "2026-01-01T00:00:00.000Z"
const EPOCH = Date.parse(WORLD_NOW)
/**
 * Seeded records predate every write a case makes. The world and each case
 * seed count from their own epoch, so adding world records does not shift the
 * timestamps a case's records get.
 */
const WORLD_SEED_EPOCH = Date.parse("2025-01-01T00:00:00.000Z")
const CASE_SEED_EPOCH = Date.parse("2025-06-01T00:00:00.000Z")

export class Store {
  readonly #types = new Map<string, Map<string, EntityRecord>>()
  #ids = 0
  #ticks = 0
  #seedTicks = 0
  #seedEpoch = WORLD_SEED_EPOCH
  #seeds = 0
  #syncId = 1000

  constructor(...seeds: Seed[]) {
    for (const seed of seeds) this.seed(seed)
  }

  seed(seed: Seed): void {
    this.#seedEpoch = this.#seeds++ === 0 ? WORLD_SEED_EPOCH : CASE_SEED_EPOCH
    this.#seedTicks = 0
    for (const [typename, records] of Object.entries(seed)) {
      for (const record of expandRepeats(records)) {
        const id = typeof record.id === "string" ? record.id : this.newId()
        const existing = this.find(typename, id)
        if (existing != null) Object.assign(existing, record)
        else {
          this.insert({
            ...withDefaults(this, typename, record),
            id,
            __typename: typename,
          })
        }
      }
    }
  }

  seedTimestamp(): string {
    this.#seedTicks++
    return new Date(this.#seedEpoch + this.#seedTicks * 1000).toISOString()
  }

  newId(): string {
    this.#ids++
    return `f0000000-0000-4000-8000-${this.#ids.toString().padStart(12, "0")}`
  }

  /** The world's current time, for date-derived fields such as cycle state. */
  worldNow(): string {
    return new Date(EPOCH).toISOString()
  }

  /** Deterministic, strictly increasing timestamps for writes. */
  now(): string {
    this.#ticks++
    return new Date(EPOCH + this.#ticks * 1000).toISOString()
  }

  nextSyncId(): number {
    return ++this.#syncId
  }

  insert(record: EntityRecord): EntityRecord {
    let table = this.#types.get(record.__typename)
    if (table == null) {
      table = new Map()
      this.#types.set(record.__typename, table)
    }
    table.set(record.id, record)
    return record
  }

  find(typename: string, id: string): EntityRecord | undefined {
    return this.#types.get(typename)?.get(id)
  }

  /** Find a record by ID across the given concrete types. */
  findAny(typenames: readonly string[], id: string): EntityRecord | undefined {
    for (const typename of typenames) {
      const record = this.find(typename, id)
      if (record != null) return record
    }
    return undefined
  }

  all(typename: string): EntityRecord[] {
    return [...(this.#types.get(typename)?.values() ?? [])]
  }

  remove(typename: string, id: string): void {
    this.#types.get(typename)?.delete(id)
  }

  singleton(typename: string): EntityRecord {
    const [record] = this.all(typename)
    if (record == null) throw new Error(`fake: seed has no ${typename}`)
    return record
  }

  viewer(): EntityRecord {
    const viewer = this.all("User").find((user) => user.isMe === true)
    if (viewer == null) throw new Error("fake: seed has no User with isMe")
    return viewer
  }

  /** An independent copy, for answering reads from an earlier moment. */
  clone(): Store {
    const copy = new Store()
    for (const [typename, table] of this.#types) {
      for (const record of table.values()) copy.insert(structuredClone(record))
    }
    copy.#ids = this.#ids
    copy.#ticks = this.#ticks
    copy.#syncId = this.#syncId
    return copy
  }

  snapshot(): Seed {
    const result: Seed = {}
    for (const [typename, table] of this.#types) {
      result[typename] = [...table.values()].map(({ __typename: _, ...rest }) =>
        rest
      )
    }
    return result
  }
}
