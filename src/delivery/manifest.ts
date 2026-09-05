import { encodeHex } from "@std/encoding/hex"
import { dirname, isAbsolute, join } from "@std/path"
import * as v from "valibot"
import { ValidationError } from "../utils/errors.ts"
import { normalizeIssueIdentifier } from "../utils/issue-identifier.ts"
import { MAX_FILE_SIZE } from "../utils/upload.ts"
import { getMimeType } from "../utils/upload.ts"

// The Issue delivery manifest previews and executes a complete Issue handoff:
// fields, comments with uploaded files, Attachments, and Relations.
// Current boundaries:
// - Field vocabulary matches what the reused `issue create/update` commands
//   accept; names resolve through those commands' existing semantics. Fields
//   the commands cannot express (estimate, due date, cycle, milestone,
//   clearing project/parent) stay out until the commands grow them.
// - `base` carries the values the caller last read. Replacement fields require
//   a matching base; incremental operations remain owned by their commands.
// - Existing comments, attachments, and relations are never edited or
//   removed here; dedicated commands own explicit single-object changes.

const priority = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(4))

const setSchema = v.strictObject({
  title: v.optional(v.string()),
  description: v.optional(v.string()),
  descriptionFile: v.optional(v.string()),
  priority: v.optional(priority),
  state: v.optional(v.string()),
  assignee: v.optional(v.nullable(v.string())),
  labels: v.optional(v.array(v.string())),
  project: v.optional(v.string()),
  parent: v.optional(v.string()),
})

const baseSchema = v.strictObject({
  title: v.optional(v.string()),
  description: v.optional(v.nullable(v.string())),
  priority: v.optional(v.nullable(priority)),
  state: v.optional(v.string()),
  assignee: v.optional(v.nullable(v.string())),
  labels: v.optional(v.array(v.string())),
  project: v.optional(v.nullable(v.string())),
  parent: v.optional(v.nullable(v.string())),
})

const commentFileSchema = v.strictObject({
  path: v.string(),
})

const commentSchema = v.strictObject({
  body: v.optional(v.string()),
  bodyFile: v.optional(v.string()),
  files: v.optional(v.array(commentFileSchema)),
  /** Applies to every attached image, mirroring `comment add --public`. */
  public: v.optional(v.boolean()),
})

const attachmentSchema = v.variant("kind", [
  v.strictObject({
    kind: v.literal("url"),
    url: v.pipe(v.string(), v.url()),
    title: v.optional(v.string()),
  }),
  v.strictObject({
    kind: v.literal("file"),
    path: v.string(),
    title: v.optional(v.string()),
  }),
])

const relationSchema = v.strictObject({
  type: v.picklist(["related", "blocks", "blocked-by", "duplicate"]),
  issue: v.pipe(
    v.string(),
    v.check(
      (value) => normalizeIssueIdentifier(value) != null,
      "Expected a complete Linear issue identifier like ENG-123",
    ),
    v.transform((value) => normalizeIssueIdentifier(value) as string),
  ),
})

const issueSchema = v.strictObject({
  operation: v.picklist(["create", "update"]),
  identifier: v.optional(v.string()),
  team: v.optional(v.string()),
  set: v.optional(setSchema),
  base: v.optional(baseSchema),
  comments: v.optional(v.array(commentSchema)),
  attachments: v.optional(v.array(attachmentSchema)),
  relations: v.optional(v.array(relationSchema)),
})

const manifestSchema = v.strictObject({
  schemaVersion: v.literal(1),
  workspace: v.pipe(v.string(), v.minLength(1)),
  issues: v.pipe(v.array(issueSchema), v.minLength(1)),
})

export type DeliveryManifest = v.InferOutput<typeof manifestSchema>
export type DeliveryIssue = DeliveryManifest["issues"][number]
export type DeliverySet = NonNullable<DeliveryIssue["set"]>
export type DeliveryBase = NonNullable<DeliveryIssue["base"]>
export type DeliveryAttachment = NonNullable<
  DeliveryIssue["attachments"]
>[number]

/** A local file referenced by the manifest, validated before any mutation. */
export interface ManifestFile {
  /** Path exactly as written in the manifest. */
  reference: string
  /** Absolute path resolved against the manifest's directory. */
  resolvedPath: string
  size: number
  contentType: string
  sha256: string
}

export interface LoadedManifest {
  manifest: DeliveryManifest
  manifestPath: string
  /** Keyed by the manifest-relative reference. */
  files: Map<string, ManifestFile>
}

function issueLabel(index: number, issue: DeliveryIssue): string {
  return issue.identifier == null
    ? `issues[${index}]`
    : `issues[${index}] (${issue.identifier})`
}

function validateIssueShape(issue: DeliveryIssue, label: string): void {
  if (issue.operation === "update" && issue.identifier == null) {
    throw new ValidationError(`${label}: update requires an identifier`)
  }
  if (issue.operation === "update" && issue.team != null) {
    throw new ValidationError(
      `${label}: team only applies to create; this delivery does not move issues between teams`,
    )
  }
  if (
    issue.operation === "update" && issue.set?.labels != null &&
    issue.set.labels.length === 0
  ) {
    throw new ValidationError(
      `${label}: set.labels cannot be an empty array; issue update cannot clear the whole label set`,
      {
        suggestion:
          "Remove labels individually with issue update --remove-label",
      },
    )
  }
  if (issue.operation === "create" && issue.set?.assignee === null) {
    throw new ValidationError(
      `${label}: set.assignee null only applies to update; issue create has no unassign flag`,
      {
        suggestion:
          "Omit assignee; creates are unassigned unless issue_create_assign_self config assigns them",
      },
    )
  }
  if (issue.operation === "create") {
    if (issue.identifier != null) {
      throw new ValidationError(
        `${label}: create must not carry an identifier; the remote assigns one`,
      )
    }
    if (issue.team == null) {
      throw new ValidationError(`${label}: create requires a team`)
    }
    if (issue.set?.title == null) {
      throw new ValidationError(`${label}: create requires set.title`)
    }
    if (issue.base != null) {
      throw new ValidationError(
        `${label}: base only applies to update operations`,
      )
    }
  }
  if (issue.set?.description != null && issue.set.descriptionFile != null) {
    throw new ValidationError(
      `${label}: set.description and set.descriptionFile are mutually exclusive`,
    )
  }
  const managed = new Set(Object.keys(issue.set ?? {}))
  managed.delete("descriptionFile")
  if (issue.set?.descriptionFile != null) managed.add("description")
  if (issue.base != null) {
    for (const key of Object.keys(issue.base)) {
      if (!managed.has(key)) {
        throw new ValidationError(
          `${label}: base.${key} has no matching field in set; base only protects fields this delivery writes`,
        )
      }
    }
  }
  for (const [position, comment] of (issue.comments ?? []).entries()) {
    if (comment.body != null && comment.bodyFile != null) {
      throw new ValidationError(
        `${label}: comments[${position}] body and bodyFile are mutually exclusive`,
      )
    }
    if (comment.body != null && comment.body.trim() === "") {
      throw new ValidationError(
        `${label}: comments[${position}] body is empty`,
      )
    }
    if (
      comment.body == null && comment.bodyFile == null &&
      (comment.files == null || comment.files.length === 0)
    ) {
      throw new ValidationError(
        `${label}: comments[${position}] needs a body, bodyFile, or files`,
      )
    }
  }
  if (issue.set != null && Object.keys(issue.set).length === 0) {
    throw new ValidationError(`${label}: set must contain at least one field`)
  }
  if (issue.operation === "update") {
    for (const key of managed) {
      if (!Object.hasOwn(issue.base ?? {}, key)) {
        const setKey =
          key === "description" && issue.set?.descriptionFile != null
            ? "descriptionFile"
            : key
        throw new ValidationError(
          `${label}: set.${setKey} requires base.${key}`,
          {
            suggestion:
              `Record the last value read from Linear in base.${key} before applying this update.`,
          },
        )
      }
    }
  }
  if (
    issue.set == null && (issue.comments ?? []).length === 0 &&
    (issue.attachments ?? []).length === 0 &&
    (issue.relations ?? []).length === 0
  ) {
    throw new ValidationError(`${label}: nothing to deliver`)
  }
}

function validateUniqueUpdateIdentifiers(issues: DeliveryIssue[]): void {
  const firstByIdentifier = new Map<
    string,
    { index: number; identifier: string }
  >()
  for (const [index, issue] of issues.entries()) {
    if (issue.operation !== "update" || issue.identifier == null) continue

    const key = normalizeIssueIdentifier(issue.identifier) ??
      issue.identifier.toUpperCase()
    const first = firstByIdentifier.get(key)
    if (first != null) {
      throw new ValidationError(
        `issues[${index}] (${issue.identifier}): duplicate update target; issues[${first.index}] (${first.identifier}) already updates the same Issue`,
        {
          suggestion:
            `Combine the fields, comments, attachments, and relations for ${issue.identifier} into one issues[] entry.`,
        },
      )
    }
    firstByIdentifier.set(key, { index, identifier: issue.identifier })
  }
}

function* fileReferences(issue: DeliveryIssue): Generator<string> {
  if (issue.set?.descriptionFile != null) yield issue.set.descriptionFile
  for (const comment of issue.comments ?? []) {
    if (comment.bodyFile != null) yield comment.bodyFile
    for (const file of comment.files ?? []) yield file.path
  }
  for (const attachment of issue.attachments ?? []) {
    if (attachment.kind === "file") yield attachment.path
  }
}

async function inventoryFile(
  reference: string,
  manifestDir: string,
): Promise<ManifestFile> {
  const resolvedPath = isAbsolute(reference)
    ? reference
    : join(manifestDir, reference)
  let info: Deno.FileInfo
  try {
    info = await Deno.stat(resolvedPath)
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new ValidationError(`Manifest file not found: ${reference}`, {
        suggestion:
          `Paths resolve relative to the manifest directory (${manifestDir})`,
      })
    }
    throw error
  }
  if (!info.isFile) {
    throw new ValidationError(`Manifest path is not a file: ${reference}`)
  }
  if (info.size > MAX_FILE_SIZE) {
    throw new ValidationError(
      `Manifest file too large: ${reference} (${info.size} bytes, max ${
        MAX_FILE_SIZE / 1024 / 1024
      }MB)`,
      { suggestion: "The upload path rejects files over 100MB" },
    )
  }
  const bytes = await Deno.readFile(resolvedPath)
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  return {
    reference,
    resolvedPath,
    size: info.size,
    contentType: getMimeType(resolvedPath),
    sha256: encodeHex(digest),
  }
}

/**
 * Parse and fully validate a delivery manifest, including every referenced
 * local file. Both plan and apply call this before any remote work, so a
 * broken third file fails the whole delivery up front instead of after two
 * successful mutations.
 */
export async function loadManifest(
  manifestPath: string,
): Promise<LoadedManifest> {
  let raw: string
  try {
    raw = await Deno.readTextFile(manifestPath)
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new ValidationError(`Manifest not found: ${manifestPath}`)
    }
    throw error
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new ValidationError(
      `Manifest is not valid JSON: ${(error as Error).message}`,
    )
  }
  const result = v.safeParse(manifestSchema, parsed)
  if (!result.success) {
    const first = result.issues[0]
    const path = v.getDotPath(first) ?? "manifest"
    throw new ValidationError(`Manifest invalid at ${path}: ${first.message}`)
  }
  const manifest = result.output
  for (const [index, issue] of manifest.issues.entries()) {
    validateIssueShape(issue, issueLabel(index, issue))
  }
  validateUniqueUpdateIdentifiers(manifest.issues)

  const manifestDir = dirname(manifestPath)
  const files = new Map<string, ManifestFile>()
  for (const issue of manifest.issues) {
    for (const reference of fileReferences(issue)) {
      if (!files.has(reference)) {
        files.set(reference, await inventoryFile(reference, manifestDir))
      }
    }
  }

  return {
    manifest,
    manifestPath,
    files,
  }
}
