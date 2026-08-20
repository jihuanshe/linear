import * as v from "valibot"
import { ValidationError } from "../utils/errors.ts"

// Checkpoints persist only outcomes that determine whether a mutation may be
// retried. `skipped` and `unattempted` describe one apply invocation and must
// never enter this file: accepting them on resume could make an invalid local
// state look authoritative.
const checkpointItemSchema = v.strictObject({
  status: v.picklist(["applied", "failed", "unknown"]),
  note: v.optional(v.string()),
})

const checkpointSchema = v.strictObject({
  schemaVersion: v.literal(1),
  manifestSha256: v.string(),
  createdIdentifiers: v.record(v.string(), v.string()),
  items: v.record(v.string(), checkpointItemSchema),
})

export type Checkpoint = v.InferOutput<typeof checkpointSchema>

export function checkpointPath(manifestPath: string): string {
  return `${manifestPath}.checkpoint.json`
}

export async function loadCheckpoint(
  manifestPath: string,
): Promise<Checkpoint | null> {
  let raw: string
  try {
    raw = await Deno.readTextFile(checkpointPath(manifestPath))
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null
    throw error
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new ValidationError(
      `Checkpoint is not valid JSON: ${(error as Error).message}`,
    )
  }

  const result = v.safeParse(checkpointSchema, parsed)
  if (!result.success) {
    const first = result.issues[0]
    const path = v.getDotPath(first) ?? "checkpoint"
    throw new ValidationError(
      `Checkpoint invalid at ${path}: ${first.message}`,
    )
  }
  return result.output
}

export async function prepareCheckpoint(
  manifestPath: string,
  manifestSha256: string,
  currentItemKeys: Iterable<string>,
): Promise<Checkpoint> {
  const existing = await loadCheckpoint(manifestPath)
  if (existing != null) {
    // An unknown mutation may already have landed, so no later work is safe
    // until a person or agent reconciles that item explicitly.
    const unknownKeys = Object.entries(existing.items)
      .filter(([, item]) => item.status === "unknown")
      .map(([key]) => key)
    if (unknownKeys.length > 0) {
      throw new ValidationError(
        `Checkpoint has unresolved unknown outcomes: ${unknownKeys.join(", ")}`,
        {
          suggestion:
            `Verify each item's remote state, then edit or remove its entry in ${
              checkpointPath(manifestPath)
            } before re-running`,
        },
      )
    }

    // Position is part of every item key. If an applied key disappears, a
    // resume could repeat the write after an insert, reorder, edit, or delete.
    const currentKeys = new Set(currentItemKeys)
    const displaced = Object.entries(existing.items)
      .filter(([key, item]) =>
        item.status === "applied" && !currentKeys.has(key)
      )
      .map(([key]) => key)
    if (displaced.length > 0) {
      throw new ValidationError(
        `Checkpoint has applied entries that no longer match any manifest item: ${
          displaced.join(", ")
        }`,
        {
          suggestion:
            `While a checkpoint exists, only fix failed items in place or append new issues at the end; inserting, reordering, removing, or editing applied entries shifts or orphans their positions and a resume would repeat writes that already landed. If the restructure is intentional, verify remote state in Linear, then rebuild or remove ${
              checkpointPath(manifestPath)
            }`,
        },
      )
    }
  }

  const checkpoint = existing ?? {
    schemaVersion: 1 as const,
    manifestSha256,
    createdIdentifiers: {},
    items: {},
  }
  checkpoint.manifestSha256 = manifestSha256
  return checkpoint
}

export async function saveCheckpoint(
  manifestPath: string,
  checkpoint: Checkpoint,
): Promise<void> {
  const target = checkpointPath(manifestPath)
  const temp = `${target}.tmp`
  await Deno.writeTextFile(temp, JSON.stringify(checkpoint, null, 2) + "\n")
  await Deno.rename(temp, target)
}
