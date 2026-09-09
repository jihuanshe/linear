import { basename, dirname } from "@std/path"
import * as v from "valibot"
import { ValidationError } from "../utils/errors.ts"

const nonempty = v.pipe(v.string(), v.minLength(1))
const workspaceSchema = v.strictObject({ id: nonempty, urlKey: nonempty })
const comparableSchema = v.union([
  v.null(),
  v.boolean(),
  v.string(),
  v.pipe(
    v.number(),
    v.check(
      (value: number) => Number.isFinite(value),
      "Expected a finite number",
    ),
  ),
  v.array(v.string()),
])
const receiptSchema = v.variant("kind", [
  v.strictObject({
    kind: v.literal("issue"),
    id: nonempty,
    identifier: nonempty,
  }),
  v.strictObject({ kind: v.literal("comment"), id: nonempty }),
  v.strictObject({ kind: v.literal("attachment"), id: nonempty }),
  v.strictObject({ kind: v.literal("relation"), id: nonempty }),
  v.strictObject({
    kind: v.literal("upload"),
    assetUrl: v.pipe(v.string(), v.url()),
    filename: nonempty,
    size: v.pipe(v.number(), v.integer(), v.minValue(0)),
    contentType: nonempty,
    public: v.boolean(),
  }),
])

const itemSchema = v.pipe(
  v.strictObject({
    status: v.picklist(["completed", "failed", "unknown"]),
    effect: v.picklist(["none", "applied", "unknown"]),
    receipt: v.optional(receiptSchema),
    expected: v.optional(v.record(nonempty, comparableSchema)),
    note: v.optional(v.string()),
    data: v.optional(v.unknown()),
  }),
  v.check(
    (item) =>
      item.status !== "completed" ||
      (item.receipt != null && item.effect !== "unknown"),
    "Completed items require a receipt and a none or applied effect",
  ),
  v.check(
    (item) =>
      item.status !== "failed" ||
      (item.effect === "none" && item.receipt == null),
    "Failed items must have no effect and no receipt",
  ),
  v.check(
    (item) =>
      item.status !== "unknown" ||
      (item.effect !== "none" && item.receipt == null),
    "Unknown items require an unknown or applied effect and no receipt",
  ),
  v.check(
    (item) => item.expected == null || item.receipt?.kind === "issue",
    "Expected fields require an issue receipt",
  ),
  v.check(
    (item) => item.data === undefined || item.status === "unknown",
    "Raw outcome evidence belongs only to unknown items",
  ),
)

const checkpointSchema = v.strictObject({
  schemaVersion: v.literal(2),
  workspace: workspaceSchema,
  items: v.record(nonempty, itemSchema),
})

export type Comparable = v.InferOutput<typeof comparableSchema>
export type DeliveryReceipt = v.InferOutput<typeof receiptSchema>
export type CheckpointItem = v.InferOutput<typeof itemSchema>
export type Checkpoint = v.InferOutput<typeof checkpointSchema>

export function checkpointPath(manifestPath: string): string {
  return `${manifestPath}.checkpoint.json`
}

function rejectOmittedRecordKeys(record: unknown, label: string): void {
  if (record == null || typeof record !== "object") return
  for (const key of Object.keys(record)) {
    if (["__proto__", "prototype", "constructor"].includes(key)) {
      throw new ValidationError(
        `Checkpoint contains an unsupported ${label}: ${key}`,
      )
    }
  }
}

function parseCheckpoint(value: unknown, path: string): Checkpoint {
  if (
    value != null && typeof value === "object" &&
    Object.hasOwn(value, "schemaVersion") &&
    (value as { schemaVersion: unknown }).schemaVersion === 1
  ) {
    throw new ValidationError(
      "Checkpoint schema v1 cannot be resumed by this CLI",
      {
        suggestion:
          `Keep ${path} unchanged and reconcile its original execution records with Linear. After accounting for those effects, create a separate v2 manifest for the explicitly remaining work. Do not delete or overwrite the old ledger to replay its intent.`,
      },
    )
  }
  // Valibot records deliberately omit unsafe object keys. A ledger must
  // reject them instead of silently discarding a persisted execution item.
  if (value != null && typeof value === "object" && "items" in value) {
    const items = value.items
    if (items != null && typeof items === "object") {
      rejectOmittedRecordKeys(items, "execution key")
      for (const item of Object.values(items)) {
        if (item != null && typeof item === "object" && "expected" in item) {
          rejectOmittedRecordKeys(item.expected, "expected field")
        }
      }
    }
  }
  const result = v.safeParse(checkpointSchema, value)
  if (!result.success) {
    const first = result.issues[0]
    throw new ValidationError(
      `Checkpoint invalid at ${
        v.getDotPath(first) ?? "checkpoint"
      }: ${first.message}`,
      {
        suggestion:
          `Retain ${path} and reconcile its recorded effects before retrying.`,
      },
    )
  }
  return result.output
}

/** The argument is the manifest path; a missing ledger is the only null case. */
export async function loadCheckpoint(
  manifestPath: string,
): Promise<Checkpoint | null> {
  const path = checkpointPath(manifestPath)
  let raw: string
  try {
    raw = await Deno.readTextFile(path)
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null
    throw error
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new ValidationError(
      `Checkpoint is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
      {
        suggestion:
          `Retain ${path}; an unreadable ledger does not prove that no writes occurred. Reconcile it before retrying.`,
      },
    )
  }
  return parseCheckpoint(parsed, path)
}

function requireWorkspace(
  actual: Checkpoint["workspace"],
  expected: Checkpoint["workspace"],
): void {
  if (actual.id !== expected.id || actual.urlKey !== expected.urlKey) {
    throw new ValidationError("Checkpoint belongs to a different workspace", {
      suggestion:
        "Use the original workspace and manifest; do not reset the checkpoint to retarget completed writes.",
    })
  }
}

const receiptKinds: Record<string, DeliveryReceipt["kind"]> = {
  fields: "issue",
  upload: "upload",
  comment: "comment",
  attachment: "attachment",
  relation: "relation",
}

export async function prepareCheckpoint(
  manifestPath: string,
  currentItems: Iterable<{ key: string; kind: string }>,
  workspace: Checkpoint["workspace"],
): Promise<Checkpoint> {
  // Validate the supplied workspace even when no ledger exists yet.
  const empty = parseCheckpoint(
    { schemaVersion: 2, workspace, items: {} },
    checkpointPath(manifestPath),
  )
  const kinds = new Map<string, string>()
  for (const item of currentItems) {
    if (!item.key || kinds.has(item.key)) {
      throw new ValidationError(
        `Execution item keys must be nonempty and unique: ${item.key}`,
      )
    }
    if (!Object.hasOwn(receiptKinds, item.kind)) {
      throw new ValidationError(
        `Unsupported checkpoint item kind: ${item.kind}`,
      )
    }
    kinds.set(item.key, item.kind)
  }
  const existing = await loadCheckpoint(manifestPath)
  if (existing == null) return empty
  requireWorkspace(existing.workspace, workspace)
  const unknown = Object.entries(existing.items).filter(([, item]) =>
    item.status === "unknown"
  ).map(([key]) => key)
  if (unknown.length > 0) {
    throw new ValidationError(
      `Checkpoint has unresolved unknown outcomes: ${unknown.join(", ")}`,
      {
        suggestion: `Reconcile the recorded effects and receipts in ${
          checkpointPath(manifestPath)
        } before continuing. Do not delete entries, refresh the original basis, or replay mutations to guess their outcome.`,
      },
    )
  }
  for (const [key, item] of Object.entries(existing.items)) {
    if (item.status === "completed" && !kinds.has(key)) {
      throw new ValidationError(
        `Checkpoint has completed entries that no longer match the current execution items: ${key}`,
        {
          suggestion:
            "Restore the original intent and files or reconcile completed effects before preparing separate remaining work; do not replay completed entries under new keys.",
        },
      )
    }
    if (
      item.receipt != null &&
      item.receipt.kind !== receiptKinds[kinds.get(key) ?? ""]
    ) {
      throw new ValidationError(
        `Checkpoint receipt does not match execution item ${key}`,
      )
    }
  }
  return existing
}

/** Persist the entire validated ledger before the caller may emit a mutation. */
export async function saveCheckpoint(
  manifestPath: string,
  checkpoint: Checkpoint,
): Promise<void> {
  const target = checkpointPath(manifestPath)
  const validated = parseCheckpoint(checkpoint, target)
  // Never replace a legacy or unreadable ledger with a new empty v2 file.
  const existing = await loadCheckpoint(manifestPath)
  if (existing != null) {
    requireWorkspace(existing.workspace, validated.workspace)
    for (const [key, item] of Object.entries(existing.items)) {
      const next = validated.items[key]
      if (item.status === "completed" && next?.status !== "completed") {
        throw new ValidationError(
          `Cannot discard or downgrade completed checkpoint item: ${key}`,
        )
      }
      if (item.status === "unknown" && next == null) {
        throw new ValidationError(
          `Cannot discard unknown checkpoint item: ${key}`,
        )
      }
    }
  }
  const bytes = new TextEncoder().encode(
    JSON.stringify(validated, null, 2) + "\n",
  )
  const temp = await Deno.makeTempFile({
    dir: dirname(target),
    prefix: `${basename(target)}.tmp-`,
  })
  try {
    const file = await Deno.open(temp, { write: true, truncate: true })
    try {
      let offset = 0
      while (offset < bytes.length) {
        const written = await file.write(bytes.subarray(offset))
        if (written === 0) {
          throw new Error("Could not finish writing checkpoint")
        }
        offset += written
      }
      await file.sync()
    } finally {
      file.close()
    }
    await Deno.rename(temp, target)
  } catch (error) {
    // Preserve the write/rename failure. An orphan temporary file is never
    // loaded as a ledger and cannot authorize a retry.
    await Deno.remove(temp).catch(() => {})
    throw error
  }
}
