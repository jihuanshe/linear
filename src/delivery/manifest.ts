import { encodeHex } from "@std/encoding/hex"
import { dirname, isAbsolute, join } from "@std/path"
import * as v from "valibot"
import { ValidationError } from "../utils/errors.ts"
import { normalizeIssueIdentifier } from "../utils/issue-identifier.ts"
import { isLinearUuid } from "../utils/linear.ts"
import {
  getMimeType,
  MAX_FILE_SIZE,
  resolveMakePublic,
} from "../utils/upload.ts"
import {
  asRecord,
  type ReadBasis,
  validateReplacementOptions,
} from "../utils/replacement.ts"

// v2 carries the native original read rather than a hand-transcribed list of
// old names. set uses the same option names consumed by createIssue/updateIssue.
const referenceSchema = v.pipe(
  v.string(),
  v.check(
    (value) => isLinearUuid(value) || normalizeIssueIdentifier(value) != null,
    "Use an Issue UUID or a complete identifier such as ENG-123",
  ),
  v.transform((value) =>
    normalizeIssueIdentifier(value) ?? value.toLowerCase()
  ),
)
const setSchema = v.strictObject({
  title: v.optional(v.string()),
  description: v.optional(v.string()),
  descriptionFile: v.optional(v.pipe(v.string(), v.minLength(1))),
  priority: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(4)),
  ),
  estimate: v.optional(v.number()),
  dueDate: v.optional(v.string()),
  state: v.optional(v.string()),
  assignee: v.optional(v.string()),
  unassign: v.optional(v.boolean()),
  label: v.optional(v.array(v.string())),
  addLabel: v.optional(v.array(v.string())),
  removeLabel: v.optional(v.array(v.string())),
  team: v.optional(v.string()),
  project: v.optional(v.string()),
  parent: v.optional(referenceSchema),
  milestone: v.optional(v.string()),
  cycle: v.optional(v.string()),
  clearCycle: v.optional(v.boolean()),
  useDefaultTemplate: v.optional(v.boolean()),
})
const commentSchema = v.strictObject({
  body: v.optional(v.string()),
  bodyFile: v.optional(v.pipe(v.string(), v.minLength(1))),
  files: v.optional(
    v.array(v.strictObject({ path: v.pipe(v.string(), v.minLength(1)) })),
  ),
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
    path: v.pipe(v.string(), v.minLength(1)),
    title: v.optional(v.string()),
  }),
])
const relationSchema = v.strictObject({
  type: v.picklist(["related", "blocks", "blocked-by", "duplicate"]),
  issue: referenceSchema,
})
const issueSchema = v.strictObject({
  operation: v.picklist(["create", "update"]),
  identifier: v.optional(referenceSchema),
  set: v.optional(setSchema),
  base: v.optional(v.record(v.string(), v.unknown())),
  baseFile: v.optional(v.pipe(v.string(), v.minLength(1))),
  unprotected: v.optional(v.boolean()),
  expectFields: v.optional(v.array(v.string())),
  comments: v.optional(v.array(commentSchema)),
  attachments: v.optional(v.array(attachmentSchema)),
  relations: v.optional(v.array(relationSchema)),
})
const manifestSchema = v.strictObject({
  schemaVersion: v.literal(2),
  workspace: v.pipe(v.string(), v.minLength(1)),
  issues: v.pipe(v.array(issueSchema), v.minLength(1)),
})

export type DeliveryManifest = v.InferOutput<typeof manifestSchema>
export type DeliveryIssue = DeliveryManifest["issues"][number]
export type DeliverySet = NonNullable<DeliveryIssue["set"]>
export type DeliveryAttachment = NonNullable<
  DeliveryIssue["attachments"]
>[number]

export interface ManifestFile {
  reference: string
  resolvedPath: string
  size: number
  contentType: string
  sha256: string
  /** Text inputs are captured from the same bytes that produced sha256. */
  content?: string
}
export interface LoadedManifest {
  manifest: DeliveryManifest
  manifestPath: string
  files: Map<string, ManifestFile>
  originals: Map<number, ReadBasis>
}

function validateIssue(issue: DeliveryIssue, index: number): void {
  const label = "issues[" + index + "]"
  if (issue.operation === "create") {
    if (
      issue.identifier != null || issue.base != null ||
      issue.baseFile != null || issue.unprotected || issue.expectFields?.length
    ) {
      throw new ValidationError(
        label + ": create cannot carry an existing target or replacement basis",
      )
    }
    if (!issue.set?.title || !issue.set.team) {
      throw new ValidationError(
        label + ": create requires set.title and set.team",
      )
    }
    if (
      issue.set.unassign || issue.set.clearCycle ||
      issue.set.addLabel != null || issue.set.removeLabel != null
    ) {
      throw new ValidationError(
        label + ": update-only options cannot be used for create",
      )
    }
  } else {
    if (!issue.identifier) {
      throw new ValidationError(
        label + ": update requires identifier (UUID or complete issue code)",
      )
    }
    if (issue.set?.useDefaultTemplate !== undefined) {
      throw new ValidationError(
        label + ": useDefaultTemplate only applies to create",
      )
    }
    if (issue.base != null && issue.baseFile != null) {
      throw new ValidationError(label + ": provide base or baseFile, not both")
    }
    if (
      issue.set == null &&
      (issue.base != null || issue.baseFile != null || issue.unprotected ||
        issue.expectFields?.length)
    ) {
      throw new ValidationError(
        label + ": replacement basis and expectations require a set operation",
      )
    }
  }
  const set = issue.set
  if (set != null) {
    if (Object.keys(set).length === 0) {
      throw new ValidationError(label + ": set must not be empty")
    }
    if (set.description !== undefined && set.descriptionFile !== undefined) {
      throw new ValidationError(
        label + ": description and descriptionFile are mutually exclusive",
      )
    }
    if (set.assignee !== undefined && set.unassign) {
      throw new ValidationError(
        label + ": assignee and unassign are mutually exclusive",
      )
    }
    if (set.cycle !== undefined && set.clearCycle) {
      throw new ValidationError(
        label + ": cycle and clearCycle are mutually exclusive",
      )
    }
    if (
      set.label != null && (set.addLabel != null || set.removeLabel != null)
    ) {
      throw new ValidationError(
        label + ": label replacement and incremental labels cannot be combined",
      )
    }
    if (issue.operation === "update" && set.label?.length === 0) {
      throw new ValidationError(
        label +
          ": empty label replacement is unsupported; remove labels explicitly",
      )
    }
  }
  for (const [position, comment] of (issue.comments ?? []).entries()) {
    const field = label + ".comments[" + position + "]"
    if (comment.body !== undefined && comment.bodyFile !== undefined) {
      throw new ValidationError(
        field + ": body and bodyFile are mutually exclusive",
      )
    }
    if (comment.body != null && comment.body.trim() === "") {
      throw new ValidationError(field + ": body is empty")
    }
    if (
      comment.body == null && comment.bodyFile == null && !comment.files?.length
    ) throw new ValidationError(field + ": no content")
    if (comment.public && !comment.files?.length) {
      throw new ValidationError(field + ": public requires files")
    }
  }
  for (const attachment of issue.attachments ?? []) {
    if (
      attachment.kind === "url" &&
      !["http:", "https:"].includes(new URL(attachment.url).protocol)
    ) {
      throw new ValidationError(
        label + ": attachment URL must use HTTP or HTTPS",
      )
    }
  }
  if (
    set == null && !issue.comments?.length && !issue.attachments?.length &&
    !issue.relations?.length
  ) {
    throw new ValidationError(label + ": nothing to deliver")
  }
}

function references(manifest: DeliveryManifest): Map<string, boolean> {
  const files = new Map<string, boolean>()
  const add = (path: string | undefined, text: boolean) => {
    if (path != null) files.set(path, text || files.get(path) === true)
  }
  for (const issue of manifest.issues) {
    add(issue.baseFile, true)
    add(issue.set?.descriptionFile, true)
    for (const comment of issue.comments ?? []) {
      add(comment.bodyFile, true)
      for (const file of comment.files ?? []) add(file.path, false)
    }
    for (const attachment of issue.attachments ?? []) {
      if (attachment.kind === "file") add(attachment.path, false)
    }
  }
  return files
}

async function inventoryFile(
  reference: string,
  manifestDir: string,
  text: boolean,
): Promise<ManifestFile> {
  const resolvedPath = isAbsolute(reference)
    ? reference
    : join(manifestDir, reference)
  let info: Deno.FileInfo
  try {
    info = await Deno.stat(resolvedPath)
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new ValidationError("Manifest file not found: " + reference, {
        suggestion: "Paths resolve relative to " + manifestDir,
      })
    }
    throw error
  }
  if (!info.isFile) {
    throw new ValidationError("Manifest path is not a file: " + reference)
  }
  if (info.size > MAX_FILE_SIZE) {
    throw new ValidationError("Manifest file too large: " + reference)
  }
  const bytes = await Deno.readFile(resolvedPath)
  if (bytes.byteLength > MAX_FILE_SIZE) {
    throw new ValidationError(
      "Manifest file grew beyond its size limit: " + reference,
    )
  }
  return {
    reference,
    resolvedPath,
    size: bytes.byteLength,
    contentType: getMimeType(resolvedPath),
    sha256: encodeHex(await crypto.subtle.digest("SHA-256", bytes)),
    ...(text
      ? { content: new TextDecoder("utf-8", { fatal: true }).decode(bytes) }
      : {}),
  }
}

export function contentFrom(
  loaded: LoadedManifest,
  inline?: string,
  file?: string,
): string | undefined {
  if (file == null) return inline
  const content = loaded.files.get(file)?.content
  if (content === undefined) {
    throw new ValidationError("Text file was not captured: " + file)
  }
  return content
}

export async function loadManifest(
  manifestPath: string,
): Promise<LoadedManifest> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await Deno.readTextFile(manifestPath))
  } catch (error) {
    throw new ValidationError("Cannot read manifest JSON: " + manifestPath, {
      suggestion: error instanceof Error ? error.message : String(error),
    })
  }
  if (
    parsed != null && typeof parsed === "object" && "schemaVersion" in parsed &&
    parsed.schemaVersion === 1
  ) {
    throw new ValidationError("Delivery schemaVersion 1 is retired", {
      suggestion:
        "Keep its checkpoint. Reconcile or finish it with the matching older binary before creating a v2 delivery from original reads; never discard execution records to retry.",
    })
  }
  const result = v.safeParse(manifestSchema, parsed)
  if (!result.success) {
    const first = result.issues[0]
    throw new ValidationError(
      "Manifest invalid at " + (v.getDotPath(first) ?? "manifest") + ": " +
        first.message,
    )
  }
  const manifest = result.output
  for (const [index, issue] of manifest.issues.entries()) {
    validateIssue(issue, index)
  }
  const files = new Map<string, ManifestFile>()
  for (const [reference, text] of references(manifest)) {
    files.set(
      reference,
      await inventoryFile(reference, dirname(manifestPath), text),
    )
  }
  const originals = new Map<number, ReadBasis>()
  const targets = new Set<string>()
  for (const [index, issue] of manifest.issues.entries()) {
    for (const comment of issue.comments ?? []) {
      if (
        comment.bodyFile != null &&
        files.get(comment.bodyFile)?.content?.trim() === ""
      ) {
        throw new ValidationError(
          "Comment body file is empty: " + comment.bodyFile,
        )
      }
      for (const file of comment.files ?? []) {
        resolveMakePublic(files.get(file.path)!.contentType, comment.public)
      }
    }
    if (issue.operation !== "update") continue
    let original = issue.base
    if (issue.baseFile != null) {
      try {
        original = asRecord(
          JSON.parse(files.get(issue.baseFile)!.content!),
          "Original read",
        )
      } catch {
        throw new ValidationError(
          "Original read is not valid JSON: " + issue.baseFile,
        )
      }
    }
    let identity = normalizeIssueIdentifier(issue.identifier!) ??
      issue.identifier!.toLowerCase()
    if (original != null) {
      const organization = asRecord(
        original.organization,
        "Original organization",
      )
      const object = asRecord(original.issue, "Original issue")
      if (
        typeof organization.id !== "string" || !organization.id ||
        organization.urlKey !== manifest.workspace ||
        typeof object.id !== "string" || !object.id
      ) {
        throw new ValidationError(
          "Original read must identify the Issue and manifest workspace",
        )
      }
      identity = object.id.toLowerCase()
      originals.set(index, original)
    }
    const set = issue.set
    const replacement = set != null &&
      Object.keys(set).some((key) => !["addLabel", "removeLabel"].includes(key))
    if (replacement || original != null || issue.expectFields?.length) {
      validateReplacementOptions({
        original,
        unprotected: issue.unprotected,
        expectFields: issue.expectFields,
      })
    }
    if (targets.has(identity)) {
      throw new ValidationError("Duplicate update target: " + identity)
    }
    targets.add(identity)
  }
  return { manifest, manifestPath, files, originals }
}
