import { encodeHex } from "@std/encoding/hex"
import { gql } from "../__codegen__/gql.ts"
import { getCliWorkspace, setCliWorkspace } from "../config.ts"
import {
  createIssue,
  prepareIssueCreate,
} from "../commands/issue/issue-create.ts"
import {
  issueReplacementFields,
  prepareIssueUpdate,
  updateIssue,
} from "../commands/issue/issue-update.ts"
import {
  addIssueRelation,
  assertDistinctIssueTargets,
  readIssueRelationInventory,
} from "../commands/issue/issue-relation.ts"
import {
  createIssueAttachment,
  createIssueComment,
  linkIssueUrl,
} from "../operations/issue-content.ts"
import { getGraphQLClient, withGraphQLContext } from "../utils/graphql.ts"
import { readIssueBasis, readIssueHeader } from "../utils/issue-read.ts"
import {
  EMPTY_ISSUE_RELATION_SNAPSHOT,
  extractIssueRelationSnapshot,
  type IssueRelationPlan,
  planIssueRelations,
} from "../utils/linear.ts"
import {
  asRecord,
  type Comparable,
  ConflictError,
  type FieldReader,
  type ReplacementFieldPlan,
} from "../utils/replacement.ts"
import { errorResult, ValidationError, WriteError } from "../utils/errors.ts"
import { formatAsMarkdownLink, uploadFile } from "../utils/upload.ts"
import { type WriteEffect } from "../utils/write-result.ts"
import {
  contentFrom,
  type DeliveryIssue,
  type LoadedManifest,
} from "./manifest.ts"
import {
  type Checkpoint,
  type CheckpointItem,
  type DeliveryReceipt,
  prepareCheckpoint,
  saveCheckpoint,
} from "./checkpoint.ts"

type ItemKind = "fields" | "upload" | "comment" | "attachment" | "relation"
type ItemStatus = "applied" | "failed" | "unknown" | "unattempted" | "skipped"
type IssueReceipt = Extract<DeliveryReceipt, { kind: "issue" }>
type UploadReceipt = Extract<DeliveryReceipt, { kind: "upload" }>

interface Completion {
  effect: "none" | "applied"
  receipt: DeliveryReceipt
  expected?: Record<string, Comparable>
}
interface DeliveryItem {
  key: string
  kind: ItemKind
  describe: string
  run(
    state: ExecutionState,
    beforeWrite: () => Promise<void>,
  ): Promise<Completion>
}
interface ExecutionState {
  loaded: LoadedManifest
  checkpoint: Checkpoint
  issueIndex: number
  target?: IssueReceipt
  related: Map<number, Awaited<ReturnType<typeof readIssueHeader>>>
}
export interface ItemResult {
  key: string
  kind: ItemKind
  describe: string
  status: ItemStatus
  effect: WriteEffect
  receipt?: DeliveryReceipt
  detail?: string
  error?: ReturnType<typeof errorResult>
}
export interface VerificationResult {
  issueIndex: number
  target: string
  status: "verified" | "different" | "unavailable"
  scope: "issue-fields-and-object-identities"
  detail?: string
  url?: string
}
export interface ApplyOutcome {
  status:
    | "completed"
    | "applied-unverified"
    | "completed-with-failures"
    | "stopped-on-failure"
    | "stopped-on-unknown"
    | "conflict"
  effect: WriteEffect
  items: ItemResult[]
  summary: Record<ItemStatus, number>
  createdIdentifiers: Record<string, string>
  verification: VerificationResult[]
  readBack: Record<string, unknown>
}
export interface ApplyContext {
  loaded: LoadedManifest
  onProgress?: (line: string) => void
  continueOnFailure?: boolean
  verificationTimeoutMs?: number
  verificationDelay?: (milliseconds: number) => Promise<void>
}
export interface PlanOutcome {
  workspace: string
  status: "ready" | "conflict" | "failed"
  issues: Array<{
    operation: "create" | "update"
    target?: string
    fields: ReplacementFieldPlan[]
    content: unknown
    relations: IssueRelationPlan[]
    items: Array<
      { key: string; kind: ItemKind; describe: string; completed: boolean }
    >
    error?: ReturnType<typeof errorResult>
  }>
  files: Array<
    { reference: string; size: number; contentType: string; sha256: string }
  >
}

const Organization = gql(`
  query GetDeliveryOrganization { organization { id urlKey } }
`)
const CommentReceipt = gql(`
  query GetDeliveryCommentReceipt($id: String!) {
    comment(id: $id) { id issue { id } }
  }
`)
const AttachmentReceipt = gql(`
  query GetDeliveryAttachmentReceipt($id: String!) {
    attachment(id: $id) { id issue { id } }
  }
`)
const RelationReceipt = gql(`
  query GetDeliveryRelationReceipt($id: String!) {
    issueRelation(id: $id) { id issue { id } relatedIssue { id } }
  }
`)

async function inWorkspace<T>(
  loaded: LoadedManifest,
  action: (organization: Checkpoint["workspace"]) => Promise<T>,
): Promise<T> {
  return await withGraphQLContext(async () => {
    const previous = getCliWorkspace()
    if (previous != null && previous !== loaded.manifest.workspace) {
      throw new ValidationError(
        "CLI workspace does not match the delivery workspace",
      )
    }
    if (Deno.env.get("LINEAR_API_KEY") == null) {
      setCliWorkspace(loaded.manifest.workspace)
    }
    try {
      const identity = await getGraphQLClient().request(Organization)
      const organization = identity?.organization
      if (
        !organization?.id || organization.urlKey !== loaded.manifest.workspace
      ) {
        throw new ValidationError(
          "Resolved credentials do not belong to delivery workspace " +
            loaded.manifest.workspace,
        )
      }
      return await action(organization)
    } finally {
      setCliWorkspace(previous)
    }
  })
}

function setOptions(loaded: LoadedManifest, issue: DeliveryIssue) {
  const { descriptionFile, ...set } = issue.set ?? {}
  const description = contentFrom(loaded, set.description, descriptionFile)
  return { ...set, ...(description === undefined ? {} : { description }) }
}
function expectedFields(fields: unknown): Record<string, Comparable> {
  const expected: Record<string, Comparable> = {}
  if (!Array.isArray(fields)) return expected
  for (const entry of fields) {
    const field = asRecord(entry, "Field result")
    if (typeof field.inputField !== "string") {
      throw new ValidationError("Field result is missing its input field")
    }
    const reader = field.inputField === "addedLabelIds" ||
        field.inputField === "removedLabelIds"
      ? issueReplacementFields.labelIds
      : (issueReplacementFields as Record<string, FieldReader>)[
        field.inputField
      ]
    if (reader == null) {
      throw new ValidationError("Unsupported field in execution result")
    }
    expected[field.inputField] = reader.normalize(field.desired)
  }
  return expected
}
function issueReceipt(value: unknown): IssueReceipt {
  const issue = asRecord(value, "Issue mutation receipt")
  if (
    typeof issue.id !== "string" || !issue.id ||
    typeof issue.identifier !== "string" || !issue.identifier
  ) {
    throw new WriteError(
      "Issue write did not return a complete identity receipt",
      { effect: "applied", data: value },
    )
  }
  return { kind: "issue", id: issue.id, identifier: issue.identifier }
}
function requireTarget(state: ExecutionState): IssueReceipt {
  if (state.target == null) {
    throw new ValidationError(
      "Issue target is not available; preceding creation has not completed",
    )
  }
  return state.target
}
function uploadReceipt(state: ExecutionState, key: string): UploadReceipt {
  const entry = state.checkpoint.items[key]
  if (entry?.status !== "completed" || entry.receipt?.kind !== "upload") {
    throw new ValidationError("Upload has not completed: " + key)
  }
  return entry.receipt
}
function activeTarget(
  read: Awaited<ReturnType<typeof readIssueBasis>>,
  organization: Checkpoint["workspace"],
): IssueReceipt {
  if (read.organization.id !== organization.id) {
    throw new ValidationError("Issue read belongs to another workspace")
  }
  if (read.issue.archivedAt != null || read.issue.trashed) {
    throw new ValidationError("Issue is archived or trashed")
  }
  if (
    typeof read.issue.id !== "string" || !read.issue.id ||
    typeof read.issue.identifier !== "string" || !read.issue.identifier
  ) {
    throw new ValidationError("Issue read returned no complete identity")
  }
  return { kind: "issue", id: read.issue.id, identifier: read.issue.identifier }
}
async function keyFor(
  index: number,
  kind: ItemKind,
  slot: string,
  payload: unknown,
): Promise<string> {
  const hash = encodeHex(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify(payload)),
    ),
  )
  return index + ":" + kind + ":" + slot + ":" + hash
}

async function expand(loaded: LoadedManifest): Promise<DeliveryItem[][]> {
  const { manifest } = loaded
  const expansions: DeliveryItem[][] = []
  for (const [index, issue] of manifest.issues.entries()) {
    const items: DeliveryItem[] = []
    const targetIdentity = {
      workspace: manifest.workspace,
      operation: issue.operation,
      identifier: issue.identifier ?? null,
    }
    const addUpload = async (
      reference: string,
      publicValue: boolean | undefined,
      slot: string,
    ): Promise<string> => {
      const file = loaded.files.get(reference)
      if (file == null) {
        throw new ValidationError("File was not inventoried: " + reference)
      }
      const key = await keyFor(index, "upload", slot, {
        targetIdentity,
        reference,
        sha256: file.sha256,
        public: publicValue === true,
      })
      items.push({
        key,
        kind: "upload",
        describe: "upload " + reference,
        async run(_state, beforeWrite) {
          const result = await uploadFile(file.resolvedPath, {
            makePublic: publicValue,
            expectedSha256: file.sha256,
            beforeWrite,
          })
          return { effect: "applied", receipt: { kind: "upload", ...result } }
        },
      })
      return key
    }
    const fieldsKey = await keyFor(index, "fields", "0", {
      targetIdentity,
      set: setOptions(loaded, issue),
      original: loaded.originals.get(index),
      unprotected: issue.unprotected,
      expectFields: issue.expectFields,
    })
    items.push({
      key: fieldsKey,
      kind: "fields",
      describe: issue.operation === "create"
        ? "create Issue in " + issue.set?.team
        : (issue.set == null ? "check Issue " : "update Issue ") +
          issue.identifier,
      async run(state, beforeWrite) {
        if (issue.operation === "create") {
          const result = await createIssue({
            ...setOptions(loaded, issue),
            interactive: false,
            beforeWrite,
          })
          return {
            effect: result.effect,
            receipt: issueReceipt(result.data.issue),
            expected: expectedFields(result.fields),
          }
        }
        const target = requireTarget(state)
        if (issue.set == null) {
          const current = await readIssueBasis(target.id)
          const receipt = activeTarget(current, state.checkpoint.workspace)
          if (receipt.id !== target.id) {
            throw new ValidationError("Issue identity changed")
          }
          return { effect: "none", receipt }
        }
        const result = await updateIssue({
          ...setOptions(loaded, issue),
          original: loaded.originals.get(index),
          unprotected: issue.unprotected,
          expectField: issue.expectFields,
          beforeWrite,
        }, target.id)
        return {
          effect: result.effect,
          receipt: issueReceipt(result.data.issue),
          expected: expectedFields(result.fields),
        }
      },
    })
    for (const [commentIndex, comment] of (issue.comments ?? []).entries()) {
      const uploads: string[] = []
      for (const [fileIndex, file] of (comment.files ?? []).entries()) {
        uploads.push(
          await addUpload(
            file.path,
            comment.public,
            "comment-" + commentIndex + "-" + fileIndex,
          ),
        )
      }
      const body = contentFrom(loaded, comment.body, comment.bodyFile)
      const key = await keyFor(index, "comment", String(commentIndex), {
        targetIdentity,
        body,
        uploads,
      })
      items.push({
        key,
        kind: "comment",
        describe: "add comment " + (commentIndex + 1),
        async run(state, beforeWrite) {
          const links = uploads.map((key) =>
            formatAsMarkdownLink(uploadReceipt(state, key))
          )
          const fullBody = [body, ...links].filter((value) =>
            value !== undefined && value !== ""
          ).join("\n\n")
          const { comment: created } = await createIssueComment(
            requireTarget(state).id,
            { body: fullBody, beforeWrite },
          )
          return {
            effect: "applied",
            receipt: { kind: "comment", id: created.id },
          }
        },
      })
    }
    for (
      const [attachmentIndex, attachment] of (issue.attachments ?? []).entries()
    ) {
      const upload = attachment.kind === "file"
        ? await addUpload(
          attachment.path,
          false,
          "attachment-" + attachmentIndex,
        )
        : undefined
      const key = await keyFor(index, "attachment", String(attachmentIndex), {
        targetIdentity,
        attachment,
        upload,
      })
      items.push({
        key,
        kind: "attachment",
        describe: attachment.kind === "file"
          ? "attach " + attachment.path
          : "link " + attachment.url,
        async run(state, beforeWrite) {
          const id = requireTarget(state).id
          const result = attachment.kind === "url"
            ? await linkIssueUrl(id, {
              url: attachment.url,
              title: attachment.title,
              beforeWrite,
            })
            : await (async () => {
              const file = uploadReceipt(state, upload!)
              return await createIssueAttachment(id, {
                url: file.assetUrl,
                title: attachment.title ?? file.filename,
                beforeWrite,
              })
            })()
          return {
            effect: "applied",
            receipt: { kind: "attachment", id: result.attachment.id },
          }
        },
      })
    }
    for (const [relationIndex, relation] of (issue.relations ?? []).entries()) {
      const key = await keyFor(index, "relation", String(relationIndex), {
        targetIdentity,
        relation,
      })
      items.push({
        key,
        kind: "relation",
        describe: "relate " + relation.type + " " + relation.issue,
        async run(state, beforeWrite) {
          const related = state.related.get(relationIndex)
          if (related == null) {
            throw new ValidationError("Relation target was not resolved")
          }
          const result = await addIssueRelation(
            requireTarget(state).id,
            relation.type,
            related.id,
            { beforeWrite },
          )
          const id = result.data.relation?.id
          if (!id) {
            throw new WriteError(
              "Relation did not return an identity receipt",
              { effect: result.effect, data: result.data },
            )
          }
          return { effect: result.effect, receipt: { kind: "relation", id } }
        },
      })
    }
    expansions.push(items)
  }
  return expansions
}

interface Inspection {
  target?: IssueReceipt
  related: Map<number, Awaited<ReturnType<typeof readIssueHeader>>>
  relations: IssueRelationPlan[]
  error?: unknown
}
async function inspect(
  loaded: LoadedManifest,
  expansions: DeliveryItem[][],
  checkpoint: Checkpoint,
): Promise<Inspection[]> {
  const inspections: Inspection[] = []
  const seen = new Set<string>()
  for (const [index, issue] of loaded.manifest.issues.entries()) {
    const result: Inspection = { related: new Map(), relations: [] }
    try {
      const fields = checkpoint.items[expansions[index][0].key]
      if (fields?.status === "completed" && fields.receipt?.kind === "issue") {
        result.target = fields.receipt
      }
      const pending = expansions[index].some((item) =>
        checkpoint.items[item.key]?.status !== "completed"
      )
      if (pending && (result.target != null || issue.operation === "update")) {
        const read = await readIssueBasis(
          result.target?.id ?? issue.identifier!,
        )
        result.target = activeTarget(read, checkpoint.workspace)
        const original = loaded.originals.get(index)
        if (original != null) {
          const object = asRecord(original.issue, "Original Issue")
          const organization = asRecord(
            original.organization,
            "Original organization",
          )
          if (
            object.id !== result.target.id ||
            organization.id !== checkpoint.workspace.id
          ) {
            throw new ValidationError(
              "Original read belongs to another Issue or workspace",
            )
          }
        }
      }
      if (result.target != null) {
        if (seen.has(result.target.id)) {
          throw new ValidationError(
            "Duplicate resolved Issue target: " + result.target.id,
          )
        }
        seen.add(result.target.id)
      }
      const pendingRelations = (issue.relations ?? []).flatMap(
        (relation, relationIndex) => {
          const item = expansions[index].filter((item) =>
            item.kind === "relation"
          )[relationIndex]
          return checkpoint.items[item.key]?.status === "completed"
            ? []
            : [{ relation, relationIndex }]
        },
      )
      for (const { relation, relationIndex } of pendingRelations) {
        const related = await readIssueHeader(relation.issue)
        if (result.target != null) {
          assertDistinctIssueTargets(result.target.id, related.id)
        }
        result.related.set(relationIndex, related)
      }
      if (pendingRelations.length > 0) {
        const inventory = result.target == null
          ? EMPTY_ISSUE_RELATION_SNAPSHOT
          : extractIssueRelationSnapshot(
            await readIssueRelationInventory(result.target.id),
          )
        result.relations = planIssueRelations(
          pendingRelations.map(({ relation, relationIndex }) => ({
            type: relation.type,
            issue: result.related.get(relationIndex)!.identifier,
            issueId: result.related.get(relationIndex)!.id,
          })),
          inventory,
        )
        const conflicts = result.relations.filter((plan) =>
          plan.verdict === "conflict"
        )
        if (conflicts.length) {
          throw new ValidationError(
            "Relation conflict: " + conflicts.map((plan) =>
              plan.detail
            ).join("; "),
          )
        }
      }
    } catch (error) {
      result.error = error
    }
    inspections.push(result)
  }
  // Known duplicate identities are a batch-shape error, before any effects.
  const targets = inspections.flatMap((value) =>
    value.target == null ? [] : [value.target.id]
  )
  if (new Set(targets).size !== targets.length) {
    throw new ValidationError(
      "Delivery resolves multiple entries to the same Issue",
    )
  }
  return inspections
}

function sameValue(a: Comparable, b: Comparable): boolean {
  return Array.isArray(a) || Array.isArray(b)
    ? Array.isArray(a) && Array.isArray(b) && a.length === b.length &&
      a.every((value, index) => value === b[index])
    : a === b
}
async function verifyOnce(
  index: number,
  target: IssueReceipt,
  items: DeliveryItem[],
  checkpoint: Checkpoint,
  signal: AbortSignal,
): Promise<{ verification: VerificationResult; data?: unknown }> {
  const base = {
    issueIndex: index,
    target: target.identifier,
    scope: "issue-fields-and-object-identities" as const,
  }
  try {
    signal.throwIfAborted()
    const read = await readIssueBasis(target.id, signal)
    if (
      read.issue.id !== target.id ||
      read.organization.id !== checkpoint.workspace.id
    ) throw new ValidationError("Read-back returned a different identity")
    const different: string[] = []
    if (read.issue.archivedAt != null || read.issue.trashed) {
      different.push("Issue is archived or trashed")
    }
    const expected = checkpoint.items[items[0].key]?.expected ?? {}
    for (const [name, desired] of Object.entries(expected)) {
      if (name === "addedLabelIds" || name === "removedLabelIds") {
        const labels = new Set(
          issueReplacementFields.labelIds.read(read.issue) as string[],
        )
        const ids = issueReplacementFields.labelIds.normalize(
          desired,
        ) as string[]
        if (
          !ids.every((id) =>
            name === "addedLabelIds" ? labels.has(id) : !labels.has(id)
          )
        ) {
          different.push(name)
        }
        continue
      }
      const reader =
        (issueReplacementFields as Record<string, FieldReader>)[name]
      if (reader == null) {
        throw new ValidationError(
          "Unsupported recorded expected field: " + name,
        )
      }
      if (!sameValue(reader.read(read.issue), reader.normalize(desired))) {
        different.push(reader.field)
      }
    }
    const observed: unknown[] = []
    const client = getGraphQLClient()
    for (const item of items) {
      const entry = checkpoint.items[item.key]
      if (entry?.status !== "completed" || !entry.receipt) continue
      const receipt = entry.receipt
      if (receipt.kind === "comment") {
        const data = await client.request({
          document: CommentReceipt,
          variables: { id: receipt.id },
          signal,
        })
        observed.push(data)
        if (
          data.comment?.id !== receipt.id ||
          data.comment.issue?.id !== target.id
        ) different.push("comment " + receipt.id)
      } else if (receipt.kind === "attachment") {
        const data = await client.request({
          document: AttachmentReceipt,
          variables: { id: receipt.id },
          signal,
        })
        observed.push(data)
        if (
          data.attachment?.id !== receipt.id ||
          data.attachment.issue?.id !== target.id
        ) different.push("attachment " + receipt.id)
      } else if (receipt.kind === "relation") {
        const data = await client.request({
          document: RelationReceipt,
          variables: { id: receipt.id },
          signal,
        })
        observed.push(data)
        if (
          data.issueRelation?.id !== receipt.id ||
          (data.issueRelation.issue.id !== target.id &&
            data.issueRelation.relatedIssue.id !== target.id)
        ) different.push("relation " + receipt.id)
      }
    }
    return {
      verification: {
        ...base,
        status: different.length ? "different" : "verified",
        url: read.issue.url,
        ...(different.length
          ? {
            detail: "Read-back differs: " + different.join(", ") +
              "; confirmed writes will not be repeated",
          }
          : {}),
      },
      data: { ...read, receipts: observed },
    }
  } catch (error) {
    return {
      verification: {
        ...base,
        status: "unavailable",
        detail: signal.aborted
          ? "Read-back timed out; confirmed writes remain recorded"
          : `Read-back unavailable: ${
            errorResult(error).error.message
          } Confirmed writes will not be repeated.`,
      },
    }
  }
}
async function verify(
  context: ApplyContext,
  index: number,
  target: IssueReceipt,
  items: DeliveryItem[],
  checkpoint: Checkpoint,
) {
  const signal = AbortSignal.timeout(context.verificationTimeoutMs ?? 10_000)
  const delay = context.verificationDelay ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)))
  let result = await verifyOnce(index, target, items, checkpoint, signal)
  for (const wait of [250, 750]) {
    if (result.verification.status === "verified" || signal.aborted) break
    await delay(wait)
    result = await verifyOnce(index, target, items, checkpoint, signal)
  }
  return result
}
function combineEffect(a: WriteEffect, b: WriteEffect): WriteEffect {
  return a === "unknown" || b === "unknown"
    ? "unknown"
    : a === "applied" || b === "applied"
    ? "applied"
    : "none"
}

export async function applyManifest(
  context: ApplyContext,
): Promise<ApplyOutcome> {
  return await inWorkspace(context.loaded, async (organization) => {
    const { loaded } = context
    const expansions = await expand(loaded)
    const checkpoint = await prepareCheckpoint(
      loaded.manifestPath,
      expansions.flat(),
      organization,
    )
    const inspections = await inspect(loaded, expansions, checkpoint)
    const results: ItemResult[] = []
    let halted = false,
      unknownSeen = false,
      conflictSeen = false,
      failedSeen = false
    let effect: WriteEffect = "none"
    for (const [index, items] of expansions.entries()) {
      const inspection = inspections[index]
      const state: ExecutionState = {
        loaded,
        checkpoint,
        issueIndex: index,
        target: inspection.target,
        related: inspection.related,
      }
      let issueStopped = false
      let inspected = false
      for (const item of items) {
        const previous = checkpoint.items[item.key]
        if (previous?.status === "completed") {
          if (previous.receipt?.kind === "issue") {
            state.target = previous.receipt
          }
          results.push({
            ...itemResult(item),
            status: "skipped",
            effect: "none",
            receipt: previous.receipt,
            detail: "Already completed; recorded effects are not repeated",
          })
          continue
        }
        if (halted || issueStopped) {
          results.push({
            ...itemResult(item),
            status: "unattempted",
            effect: "none",
          })
          continue
        }
        let started = false
        let acknowledged: Completion | undefined
        const beforeWrite = async () => {
          checkpoint.items[item.key] = {
            status: "unknown",
            effect: "unknown",
            note: "Write is in flight; reconcile if execution does not finish",
          }
          await saveCheckpoint(loaded.manifestPath, checkpoint)
          started = true
        }
        try {
          if (!inspected) {
            inspected = true
            if (inspection.error != null) throw inspection.error
          }
          context.onProgress?.(item.describe)
          const completed = await item.run(state, beforeWrite)
          acknowledged = completed
          const entry: CheckpointItem = { status: "completed", ...completed }
          checkpoint.items[item.key] = entry
          await saveCheckpoint(loaded.manifestPath, checkpoint)
          if (completed.receipt.kind === "issue") {
            state.target = completed.receipt
          }
          effect = combineEffect(effect, completed.effect)
          results.push({
            ...itemResult(item),
            status: completed.effect === "none" ? "skipped" : "applied",
            ...completed,
          })
        } catch (error) {
          const parsed = errorResult(
            acknowledged?.effect === "applied"
              ? new WriteError(
                "Write was acknowledged but its receipt could not be persisted",
                {
                  effect: "applied",
                  data: acknowledged,
                  receipts: [acknowledged.receipt],
                  cause: error,
                },
              )
              : error,
          )
          const recordedEffect = parsed.effect === "none" && started
            ? "unknown"
            : parsed.effect
          const result = { ...parsed, effect: recordedEffect }
          const unsafe = recordedEffect !== "none"
          // A process crash after beforeWrite leaves unknown on disk. During
          // this invocation, a proven pre-send failure may safely be failed.
          checkpoint.items[item.key] = unsafe
            ? {
              status: "unknown",
              effect: recordedEffect,
              note: result.error.message,
              data: result,
            }
            : { status: "failed", effect: "none", note: result.error.message }
          try {
            await saveCheckpoint(loaded.manifestPath, checkpoint)
          } catch (saveError) {
            // If a successful mutation's receipt could not be persisted, the
            // pre-send unknown marker is the only safe recovery authority.
            throw new WriteError("Cannot persist delivery outcome", {
              effect: combineEffect(effect, recordedEffect),
              data: {
                result,
                acknowledged,
                saveError: String(saveError),
                items: results,
              },
              ...(acknowledged == null
                ? {}
                : { receipts: [acknowledged.receipt] }),
              cause: saveError,
            })
          }
          results.push({
            ...itemResult(item),
            status: unsafe ? "unknown" : "failed",
            effect: recordedEffect,
            error: result,
            detail: result.error.message,
            ...(acknowledged == null ? {} : { receipt: acknowledged.receipt }),
          })
          effect = combineEffect(effect, recordedEffect)
          issueStopped = true
          if (unsafe) {
            unknownSeen = true
            halted = true
          } else {
            failedSeen = true
            if (error instanceof ConflictError) conflictSeen = true
            halted = !context.continueOnFailure
          }
        }
      }
      inspections[index].target = state.target
    }
    const verification: VerificationResult[] = []
    const readBack: Record<string, unknown> = {}
    for (const [index, items] of expansions.entries()) {
      const target = inspections[index].target
      if (
        target == null || checkpoint.items[items[0].key]?.status !== "completed"
      ) continue
      const observed = await verify(context, index, target, items, checkpoint)
      verification.push(observed.verification)
      if (observed.data !== undefined) readBack[String(index)] = observed.data
    }
    const summary: Record<ItemStatus, number> = {
      applied: 0,
      failed: 0,
      unknown: 0,
      unattempted: 0,
      skipped: 0,
    }
    for (const result of results) summary[result.status]++
    const createdIdentifiers = Object.fromEntries(
      loaded.manifest.issues.flatMap((issue, index) =>
        issue.operation === "create" && inspections[index].target != null
          ? [[String(index), inspections[index].target!.identifier]]
          : []
      ),
    )
    return {
      status: unknownSeen
        ? "stopped-on-unknown"
        : conflictSeen
        ? "conflict"
        : failedSeen
        ? (context.continueOnFailure
          ? "completed-with-failures"
          : "stopped-on-failure")
        : verification.some((result) => result.status !== "verified")
        ? "applied-unverified"
        : "completed",
      effect,
      items: results,
      summary,
      createdIdentifiers,
      verification,
      readBack,
    }
  })
}
function itemResult(item: DeliveryItem) {
  return { key: item.key, kind: item.kind, describe: item.describe }
}

function textSummary(loaded: LoadedManifest, inline?: string, file?: string) {
  if (file != null) {
    return { source: "file" as const, ...fileSummary(loaded.files.get(file)!) }
  }
  return inline == null ? undefined : {
    source: "inline" as const,
    size: new TextEncoder().encode(inline).byteLength,
  }
}
function planContent(loaded: LoadedManifest, issue: DeliveryIssue) {
  const set = setOptions(loaded, issue)
  const description = textSummary(
    loaded,
    issue.set?.description,
    issue.set?.descriptionFile,
  )
  return {
    set: { ...set, ...(description == null ? {} : { description }) },
    comments: (issue.comments ?? []).map((comment) => ({
      body: textSummary(loaded, comment.body, comment.bodyFile),
      public: comment.public === true,
      files: (comment.files ?? []).map((file) =>
        fileSummary(loaded.files.get(file.path)!)
      ),
    })),
    attachments: issue.attachments ?? [],
  }
}
function fileSummary(
  file: {
    reference: string
    size: number
    contentType: string
    sha256: string
  },
) {
  const { reference, size, contentType, sha256 } = file
  return { reference, size, contentType, sha256 }
}
export async function planManifest(
  context: Pick<ApplyContext, "loaded">,
): Promise<PlanOutcome> {
  return await inWorkspace(context.loaded, async (organization) => {
    const { loaded } = context
    const expansions = await expand(loaded)
    // prepareCheckpoint only reads and validates; plan never writes the ledger.
    const checkpoint = await prepareCheckpoint(
      loaded.manifestPath,
      expansions.flat(),
      organization,
    )
    const inspections = await inspect(loaded, expansions, checkpoint)
    const issues: PlanOutcome["issues"] = []
    let failed = false, conflict = false
    for (const [index, issue] of loaded.manifest.issues.entries()) {
      const inspection = inspections[index]
      let fields: ReplacementFieldPlan[] = []
      let error = inspection.error
      if (
        error == null &&
        checkpoint.items[expansions[index][0].key]?.status !== "completed"
      ) {
        try {
          if (issue.operation === "create") {
            await prepareIssueCreate({
              ...setOptions(loaded, issue),
              interactive: false,
            })
          } else if (issue.set != null) {
            fields = (await prepareIssueUpdate({
              ...setOptions(loaded, issue),
              original: loaded.originals.get(index),
              unprotected: issue.unprotected,
              expectField: issue.expectFields,
            }, inspection.target!.id)).fields
          }
        } catch (cause) {
          error = cause
        }
      }
      if (error != null) {
        if (error instanceof ConflictError) {
          conflict = true
          fields = error.fields
        } else failed = true
      }
      issues.push({
        operation: issue.operation,
        target: inspection.target?.identifier ?? issue.identifier,
        fields,
        content: planContent(loaded, issue),
        relations: inspection.relations,
        items: expansions[index].map((item) => ({
          ...itemResult(item),
          completed: checkpoint.items[item.key]?.status === "completed",
        })),
        ...(error == null ? {} : { error: errorResult(error) }),
      })
    }
    return {
      workspace: loaded.manifest.workspace,
      status: conflict ? "conflict" : failed ? "failed" : "ready",
      issues,
      files: [...loaded.files.values()].map(fileSummary),
    }
  })
}
