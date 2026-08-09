import { encodeHex } from "@std/encoding/hex"
import { fromFileUrl } from "@std/path"
import { CliError, ValidationError } from "../utils/errors.ts"
import type {
  DeliveryBase,
  DeliveryIssue,
  DeliverySet,
  LoadedManifest,
  ManifestFile,
} from "./manifest.ts"

// The delivery engine reuses the CLI's own commands as its execution layer by
// re-invoking this program per step. That inherits every existing resolution,
// validation, and output semantic instead of maintaining a second GraphQL
// client path — the same shape the retired Python batch Skill proved, now
// owned and versioned inside the CLI. Tests inject a fake runner, so every
// contract below is deterministic without a network.

export interface CommandResult {
  code: number
  stdout: string
  stderr: string
}

export interface CommandRunner {
  run(args: string[]): Promise<CommandResult>
}

/** Re-invoke this CLI: the compiled binary directly, or deno + main.ts in dev. */
export function selfExecRunner(): CommandRunner {
  const execPath = Deno.execPath()
  const viaDeno = /(^|[\\/])deno(\.exe)?$/.test(execPath)
  return {
    async run(args) {
      const full = viaDeno
        ? [
          "run",
          "--allow-all",
          "--quiet",
          fromFileUrl(Deno.mainModule),
          ...args,
        ]
        : args
      const output = await new Deno.Command(execPath, {
        args: full,
        stdout: "piped",
        stderr: "piped",
        env: { NO_COLOR: "1" },
      }).output()
      const decoder = new TextDecoder()
      return {
        code: output.code,
        stdout: decoder.decode(output.stdout),
        stderr: decoder.decode(output.stderr),
      }
    },
  }
}

/**
 * Linear rewrites equivalent Markdown on save. Forms observed against the
 * real API (Kadoraba sandbox, 2026-08-09): trailing whitespace stripped;
 * table delimiter rows compressed with alignment colons discarded
 * (`| :--- | ---: |` → `| -- | -- |`); link destinations wrapped in angle
 * brackets (`](url)` → `](<url>)`); bare URLs autolinked into
 * `[url](<url>)`; nested bullets flipped `- ` → `* `; underscore italics
 * flipped `_x_` → `*x*`; task checkboxes capitalized `[x]` → `[X]`.
 * Comparing normalized text keeps these rewrites from reading as remote
 * drift; anything this normalization cannot reconcile is shown as a
 * difference for the caller to judge, never silently "fixed".
 */
export function normalizeMarkdown(text: string): string {
  return text
    .replaceAll("\r\n", "\n")
    .split("\n")
    .map((line) => {
      const trimmed = line
        .replace(/[ \t]+$/, "")
        .replace(/^(\s*)\* /, "$1- ")
        .replace(/^(\s*)- \[[xX]\] /, "$1- [x] ")
        .replace(/\]\(<([^<>\s]+)>\)/g, "]($1)")
        .replace(/\[([^\]\s]+)\]\(\1\)/g, "$1")
        .replace(/\b_([^_\n]+)_(?![\w])/g, "*$1*")
      const bare = trimmed.trim()
      if (/^\|[\s|:-]+\|$/.test(bare) && bare.includes("-")) {
        // Linear discards column alignment colons entirely, so the canonical
        // delimiter cell is plain dashes.
        const cells = bare.slice(1, -1).split("|").map(() => "---")
        return `|${cells.join("|")}|`
      }
      return trimmed
    })
    .join("\n")
    .replace(/\n+$/, "")
}

/** Comparable field values extracted from `issue view --json`. */
export interface RemoteFields {
  title?: string
  description?: string | null
  priority?: number | null
  state?: string
  assignee?: { name?: string; displayName?: string } | null
  labels?: string[]
  project?: string | null
  parent?: string | null
}

export function extractRemoteFields(view: unknown): RemoteFields {
  const data = view as Record<string, unknown>
  const nested = (value: unknown, key: string): unknown =>
    value == null ? null : (value as Record<string, unknown>)[key]
  const labelsNode = nested(data.labels, "nodes")
  return {
    title: data.title as string | undefined,
    description: (data.description ?? null) as string | null,
    priority: (data.priority ?? null) as number | null,
    state: nested(data.state, "name") as string | undefined,
    assignee: (data.assignee ?? null) as RemoteFields["assignee"],
    labels: Array.isArray(labelsNode)
      ? labelsNode.map((node) => nested(node, "name") as string)
      : undefined,
    project: (nested(data.project, "name") ?? null) as string | null,
    parent: (nested(data.parent, "identifier") ?? null) as string | null,
  }
}

type FieldName = keyof DeliveryBase

const MANAGED_FIELDS: FieldName[] = [
  "title",
  "description",
  "priority",
  "state",
  "assignee",
  "labels",
  "project",
  "parent",
]

function fieldEquals(
  field: FieldName,
  manifestValue: unknown,
  remote: RemoteFields,
): boolean {
  const remoteValue = remote[field]
  switch (field) {
    case "description": {
      if (manifestValue == null || remoteValue == null) {
        return manifestValue == null && remoteValue == null
      }
      return normalizeMarkdown(manifestValue as string) ===
        normalizeMarkdown(remoteValue as string)
    }
    case "labels": {
      const a = [...(manifestValue as string[] ?? [])].sort()
      const b = [...(remoteValue as string[] ?? [])].sort()
      return a.length === b.length &&
        a.every((label, index) => label === b[index])
    }
    case "assignee": {
      const assignee = remote.assignee
      if (manifestValue == null || assignee == null) {
        return manifestValue == null && assignee == null
      }
      return manifestValue === assignee.name ||
        manifestValue === assignee.displayName
    }
    default:
      return manifestValue === (remoteValue ?? null)
  }
}

export type FieldVerdict = "write" | "idempotent" | "conflict"

export interface FieldPlan {
  field: FieldName
  desired: unknown
  base?: unknown
  remote?: unknown
  verdict: FieldVerdict
}

/**
 * Three-way comparison inherited from the batch-write Skill: a field with a
 * base is written only while the remote still matches that base; a matching
 * remote-desired pair is idempotent and skipped; anything else means a
 * colleague edited the field since the caller read it, and this delivery
 * refuses to overwrite their work.
 */
export function planFields(
  set: DeliverySet,
  base: DeliveryBase | undefined,
  remote: RemoteFields,
  resolveDescription: (set: DeliverySet) => unknown,
): FieldPlan[] {
  const plans: FieldPlan[] = []
  for (const field of MANAGED_FIELDS) {
    const desired = field === "description"
      ? resolveDescription(set)
      : set[field as keyof DeliverySet]
    if (desired === undefined) continue
    const baseValue = base?.[field]
    let verdict: FieldVerdict
    if (fieldEquals(field, desired, remote)) {
      verdict = "idempotent"
    } else if (
      baseValue === undefined || fieldEquals(field, baseValue, remote)
    ) {
      verdict = "write"
    } else {
      verdict = "conflict"
    }
    plans.push({
      field,
      desired,
      ...(baseValue === undefined ? {} : { base: baseValue }),
      remote: remote[field] ?? null,
      verdict,
    })
  }
  return plans
}

export type ItemKind = "fields" | "comment" | "attachment" | "relation"
export type ItemStatus =
  | "applied"
  | "failed"
  | "unknown"
  | "unattempted"
  | "skipped"

export interface DeliveryItem {
  key: string
  issueIndex: number
  kind: ItemKind
  subIndex: number
  /** Identifier when known; create issues resolve it at apply time. */
  target: string | null
  args: (identifier: string) => string[]
  describe: string
}

async function itemHash(payload: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(payload)),
  )
  return encodeHex(digest).slice(0, 8)
}

function fileFingerprint(
  files: Map<string, ManifestFile>,
  reference: string,
): string {
  return files.get(reference)?.sha256 ?? reference
}

/**
 * Expand one manifest issue into its ordered execution items. The fields step
 * always comes first so create issues have an identifier before comments,
 * attachments, and relations target them.
 */
export async function expandIssue(
  issue: DeliveryIssue,
  issueIndex: number,
  workspaceFlags: string[],
  files: Map<string, ManifestFile>,
): Promise<DeliveryItem[]> {
  const items: DeliveryItem[] = []
  const target = issue.identifier ?? null
  const ws = workspaceFlags

  if (issue.set != null || issue.operation === "create") {
    const set = issue.set ?? {}
    const hash = await itemHash({
      set,
      base: issue.base ?? null,
      descriptionFileSha: set.descriptionFile == null
        ? null
        : fileFingerprint(files, set.descriptionFile),
    })
    items.push({
      key: `${issueIndex}:fields:0:${hash}`,
      issueIndex,
      kind: "fields",
      subIndex: 0,
      target,
      describe: issue.operation === "create"
        ? `create issue in team ${issue.team}`
        : `update fields of ${issue.identifier}`,
      args: (identifier) => {
        const flags: string[] = []
        if (set.title != null) flags.push("--title", set.title)
        if (set.descriptionFile != null) {
          flags.push(
            "--description-file",
            files.get(set.descriptionFile)?.resolvedPath ??
              set.descriptionFile,
          )
        } else if (set.description != null) {
          flags.push("--description", set.description)
        }
        if (set.priority != null) flags.push("--priority", String(set.priority))
        if (set.state != null) flags.push("--state", set.state)
        if (set.assignee === null) flags.push("--unassign")
        else if (set.assignee != null) flags.push("--assignee", set.assignee)
        for (const label of set.labels ?? []) flags.push("--label", label)
        if (set.project != null) flags.push("--project", set.project)
        if (set.parent != null) flags.push("--parent", set.parent)
        if (issue.operation === "create") {
          return [
            "issue",
            "create",
            "--no-interactive",
            "--team",
            issue.team as string,
            ...ws,
            ...flags,
            "--json",
          ]
        }
        return ["issue", "update", identifier, ...ws, ...flags, "--json"]
      },
    })
  }

  for (const [subIndex, comment] of (issue.comments ?? []).entries()) {
    const hash = await itemHash({
      comment,
      bodyFileSha: comment.bodyFile == null
        ? null
        : fileFingerprint(files, comment.bodyFile),
      fileShas: (comment.files ?? []).map((file) =>
        fileFingerprint(files, file.path)
      ),
    })
    items.push({
      key: `${issueIndex}:comment:${subIndex}:${hash}`,
      issueIndex,
      kind: "comment",
      subIndex,
      target,
      describe: `add comment ${subIndex + 1} with ${
        (comment.files ?? []).length
      } file(s)`,
      // Comment bodies may need a temp file on disk, so the executor calls
      // buildCommentArgs for comment items instead of this synchronous hook.
      args: () => {
        throw new CliError("comment items resolve through buildCommentArgs")
      },
    })
  }

  for (const [subIndex, attachment] of (issue.attachments ?? []).entries()) {
    const hash = await itemHash({
      attachment,
      fileSha: attachment.kind === "file"
        ? fileFingerprint(files, attachment.path)
        : null,
    })
    items.push({
      key: `${issueIndex}:attachment:${subIndex}:${hash}`,
      issueIndex,
      kind: "attachment",
      subIndex,
      target,
      describe: attachment.kind === "url"
        ? `link ${attachment.url}`
        : `attach ${attachment.path}`,
      args: (identifier) =>
        attachment.kind === "url"
          ? [
            "issue",
            "link",
            identifier,
            attachment.url,
            ...ws,
            ...(attachment.title == null ? [] : ["--title", attachment.title]),
          ]
          : [
            "issue",
            "attach",
            identifier,
            files.get(attachment.path)?.resolvedPath ?? attachment.path,
            ...ws,
            ...(attachment.title == null ? [] : ["--title", attachment.title]),
          ],
    })
  }

  for (const [subIndex, relation] of (issue.relations ?? []).entries()) {
    const hash = await itemHash({ relation })
    items.push({
      key: `${issueIndex}:relation:${subIndex}:${hash}`,
      issueIndex,
      kind: "relation",
      subIndex,
      target,
      describe: `relate ${relation.type} ${relation.issue}`,
      args: (identifier) => [
        "issue",
        "relation",
        "add",
        identifier,
        relation.type,
        relation.issue,
        ...ws,
      ],
    })
  }

  return items
}

export async function buildCommentArgs(
  issue: DeliveryIssue,
  subIndex: number,
  identifier: string,
  workspaceFlags: string[],
  files: Map<string, ManifestFile>,
): Promise<{ args: string[]; cleanup: () => Promise<void> }> {
  const comment = (issue.comments ?? [])[subIndex]
  const args = ["issue", "comment", "add", identifier, ...workspaceFlags]
  let temp: string | null = null
  if (comment.bodyFile != null) {
    args.push(
      "--body-file",
      files.get(comment.bodyFile)?.resolvedPath ?? comment.bodyFile,
    )
  } else if (comment.body != null) {
    temp = await Deno.makeTempFile({ suffix: ".md" })
    await Deno.writeTextFile(temp, comment.body)
    args.push("--body-file", temp)
  }
  for (const file of comment.files ?? []) {
    args.push("--attach", files.get(file.path)?.resolvedPath ?? file.path)
  }
  if (comment.public === true) args.push("--public")
  return {
    args,
    cleanup: async () => {
      if (temp != null) await Deno.remove(temp).catch(() => {})
    },
  }
}

// ---------------------------------------------------------------------------
// Checkpoint
// ---------------------------------------------------------------------------

/**
 * The checkpoint lives beside the manifest (`<manifest>.checkpoint.json`) so
 * the next person or agent finds it with the manifest it belongs to. Items
 * are keyed by position plus a content hash: editing a failed item changes
 * its hash and re-runs it, while confirmed successes keep matching and are
 * skipped. An `unknown` entry blocks every further run until someone
 * verifies the remote outcome and edits or removes the entry — that explicit
 * reconciliation is the whole point of recording it.
 *
 * Because keys embed manifest positions, a resume refuses to run when any
 * applied entry no longer matches a current item: inserting, reordering,
 * removing, or editing applied issues would shift or orphan their keys and
 * silently repeat writes. Only in-place fixes of failed items and appends at
 * the end are safe edits while a checkpoint exists. The checkpoint is not a
 * lock — concurrent executors of the same manifest cannot see each other, so
 * a handoff must be a handover, never a fork.
 */
export interface Checkpoint {
  schemaVersion: 1
  manifestSha256: string
  createdIdentifiers: Record<string, string>
  items: Record<string, { status: ItemStatus; note?: string }>
}

export function checkpointPath(manifestPath: string): string {
  return `${manifestPath}.checkpoint.json`
}

export async function loadCheckpoint(
  manifestPath: string,
): Promise<Checkpoint | null> {
  try {
    const raw = await Deno.readTextFile(checkpointPath(manifestPath))
    const parsed = JSON.parse(raw) as Checkpoint
    if (parsed.schemaVersion !== 1) {
      throw new ValidationError(
        `Unsupported checkpoint schemaVersion in ${
          checkpointPath(manifestPath)
        }`,
      )
    }
    return parsed
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null
    throw error
  }
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

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export interface ItemResult {
  key: string
  kind: ItemKind
  describe: string
  status: ItemStatus
  detail?: string
}

export interface ApplyOutcome {
  status:
    | "completed"
    | "completed-with-failures"
    | "stopped-on-failure"
    | "stopped-on-unknown"
    | "conflict"
  items: ItemResult[]
  summary: Record<ItemStatus, number>
  createdIdentifiers: Record<string, string>
  readBack: Record<string, unknown>
}

function classifyFailure(result: CommandResult): "failed" | "unknown" {
  // A handled CLI error prints "✗ ..." before a nonzero exit; that pattern is
  // treated as "failed without remote effect". Anything else — crash, signal,
  // empty stderr — cannot prove the mutation did not land, so it is unknown
  // and stops the run until explicitly reconciled.
  return result.code !== 0 && result.stderr.includes("✗") ? "failed" : "unknown"
}

export interface ApplyContext {
  loaded: LoadedManifest
  runner: CommandRunner
  onProgress?: (line: string) => void
  /**
   * True when authentication comes from the LINEAR_API_KEY environment
   * variable. The CLI rejects --workspace in that mode (the key already pins
   * the organization), so the engine drops the flag and instead verifies via
   * `auth whoami --json` that the key's organization matches the manifest's
   * workspace before any remote work — the guard survives the auth mode.
   */
  envAuthenticated?: boolean
  /**
   * Keep executing after a confirmed `failed` item (one the CLI reported as a
   * handled error, so no remote effect landed). An `unknown` outcome always
   * stops regardless of this flag — nothing may run past an unverified
   * mutation.
   */
  continueOnFailure?: boolean
}

async function verifyEnvKeyOrganization(
  context: ApplyContext,
): Promise<string[]> {
  const { manifest } = context.loaded
  if (context.envAuthenticated !== true) {
    return ["--workspace", manifest.workspace]
  }
  const whoami = await context.runner.run(["auth", "whoami", "--json"])
  if (whoami.code !== 0) {
    throw new ValidationError(
      `Cannot verify LINEAR_API_KEY organization: ${
        whoami.stderr.trim().split("\n")[0]
      }`,
    )
  }
  const identity = JSON.parse(whoami.stdout) as {
    organization?: { urlKey?: string }
  }
  const urlKey = identity.organization?.urlKey
  if (urlKey !== manifest.workspace) {
    throw new ValidationError(
      `Manifest targets workspace ${manifest.workspace} but LINEAR_API_KEY resolves to ${
        urlKey ?? "an unknown organization"
      }`,
    )
  }
  return []
}

export async function applyManifest(
  context: ApplyContext,
): Promise<ApplyOutcome> {
  const { loaded, runner } = context
  const { manifest, manifestPath } = loaded
  const progress = context.onProgress ?? (() => {})
  const workspaceFlags = await verifyEnvKeyOrganization(context)

  const expansions: DeliveryItem[][] = []
  for (const [issueIndex, issue] of manifest.issues.entries()) {
    expansions.push(
      await expandIssue(issue, issueIndex, workspaceFlags, loaded.files),
    )
  }

  const existing = await loadCheckpoint(manifestPath)
  if (existing != null) {
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
    // Checkpoint keys embed each item's manifest position. Inserting,
    // reordering, or removing an issue shifts the positions of everything
    // after it, so every applied entry must still match a current item —
    // otherwise a resume would silently repeat writes that already landed.
    const currentKeys = new Set(
      expansions.flat().map((item) => item.key),
    )
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
  const checkpoint: Checkpoint = existing ?? {
    schemaVersion: 1,
    manifestSha256: loaded.manifestSha256,
    createdIdentifiers: {},
    items: {},
  }
  checkpoint.manifestSha256 = loaded.manifestSha256

  const results: ItemResult[] = []
  const readBack: Record<string, unknown> = {}
  // `halted` controls whether further items run; the three flags remember
  // what happened so the final status reports the strongest signal even when
  // --continue-on-failure kept the run going.
  let halted = false
  let unknownSeen = false
  let conflictSeen = false
  let failedSeen = false
  const continueOnFailure = context.continueOnFailure === true

  for (const [issueIndex, issue] of manifest.issues.entries()) {
    const items = expansions[issueIndex]

    if (halted) {
      for (const item of items) {
        results.push({
          key: item.key,
          kind: item.kind,
          describe: item.describe,
          status: "unattempted",
        })
      }
      continue
    }

    // Update issues need the current remote values before the fields step;
    // conflicts surface before any write.
    let remote: RemoteFields | null = null
    let issueHalted = false
    if (issue.operation === "update") {
      const view = await runner.run([
        "issue",
        "view",
        issue.identifier as string,
        ...workspaceFlags,
        "--json",
      ])
      if (view.code !== 0) {
        const status = classifyFailure(view)
        results.push({
          key: `${issueIndex}:fields:0:read`,
          kind: "fields",
          describe: `read current state of ${issue.identifier}`,
          status,
          detail: view.stderr.trim().split("\n")[0],
        })
        if (status === "unknown") {
          unknownSeen = true
          halted = true
        } else {
          failedSeen = true
          halted = !continueOnFailure
        }
        issueHalted = true
      } else {
        remote = extractRemoteFields(JSON.parse(view.stdout))
      }
    }

    let identifier = issue.identifier ??
      checkpoint.createdIdentifiers[String(issueIndex)] ?? null
    let issueApplied = false

    for (const item of items) {
      if (halted || issueHalted) {
        results.push({
          key: item.key,
          kind: item.kind,
          describe: item.describe,
          status: "unattempted",
        })
        continue
      }
      const recorded = checkpoint.items[item.key]
      if (recorded?.status === "applied") {
        results.push({
          key: item.key,
          kind: item.kind,
          describe: item.describe,
          status: "skipped",
          detail: "already applied per checkpoint",
        })
        continue
      }

      if (item.kind === "fields" && issue.operation === "update") {
        const fieldPlans = planFields(
          issue.set ?? {},
          issue.base,
          remote as RemoteFields,
          (set) =>
            set.descriptionFile != null
              ? readDescriptionFile(loaded, set.descriptionFile)
              : set.description,
        )
        const conflicts = fieldPlans.filter((plan) =>
          plan.verdict === "conflict"
        )
        if (conflicts.length > 0) {
          results.push({
            key: item.key,
            kind: item.kind,
            describe: item.describe,
            status: "failed",
            detail: `conflict: ${
              conflicts.map((plan) => plan.field).join(", ")
            } changed remotely since base`,
          })
          conflictSeen = true
          halted = !continueOnFailure
          issueHalted = true
          continue
        }
        if (fieldPlans.every((plan) => plan.verdict === "idempotent")) {
          checkpoint.items[item.key] = { status: "applied", note: "idempotent" }
          await saveCheckpoint(manifestPath, checkpoint)
          issueApplied = true
          results.push({
            key: item.key,
            kind: item.kind,
            describe: item.describe,
            status: "applied",
            detail: "idempotent: remote already matches",
          })
          continue
        }
      }

      if (identifier == null && item.kind !== "fields") {
        results.push({
          key: item.key,
          kind: item.kind,
          describe: item.describe,
          status: "unattempted",
          detail: "no identifier: fields step did not complete",
        })
        continue
      }

      progress(`→ ${item.describe}`)
      let commandArgs: string[]
      let cleanup: (() => Promise<void>) | null = null
      if (item.kind === "comment") {
        const built = await buildCommentArgs(
          issue,
          item.subIndex,
          identifier as string,
          workspaceFlags,
          loaded.files,
        )
        commandArgs = built.args
        cleanup = built.cleanup
      } else {
        commandArgs = item.args(identifier ?? "")
      }

      let result: CommandResult
      try {
        result = await runner.run(commandArgs)
      } catch (error) {
        checkpoint.items[item.key] = {
          status: "unknown",
          note: (error as Error).message,
        }
        await saveCheckpoint(manifestPath, checkpoint)
        results.push({
          key: item.key,
          kind: item.kind,
          describe: item.describe,
          status: "unknown",
          detail: (error as Error).message,
        })
        unknownSeen = true
        halted = true
        continue
      } finally {
        await cleanup?.()
      }

      if (result.code === 0) {
        if (item.kind === "fields" && issue.operation === "create") {
          const created = JSON.parse(result.stdout) as {
            issue?: { identifier?: string }
          }
          const createdIdentifier = created.issue?.identifier
          if (createdIdentifier == null) {
            checkpoint.items[item.key] = {
              status: "unknown",
              note: "create succeeded but no identifier in output",
            }
            await saveCheckpoint(manifestPath, checkpoint)
            results.push({
              key: item.key,
              kind: item.kind,
              describe: item.describe,
              status: "unknown",
              detail: "create output had no identifier",
            })
            unknownSeen = true
            halted = true
            continue
          }
          identifier = createdIdentifier
          checkpoint.createdIdentifiers[String(issueIndex)] = createdIdentifier
        }
        checkpoint.items[item.key] = { status: "applied" }
        await saveCheckpoint(manifestPath, checkpoint)
        issueApplied = true
        results.push({
          key: item.key,
          kind: item.kind,
          describe: item.describe,
          status: "applied",
          ...(item.kind === "fields" && identifier != null
            ? { detail: identifier }
            : {}),
        })
        continue
      }

      const status = classifyFailure(result)
      checkpoint.items[item.key] = {
        status,
        note: result.stderr.trim().split("\n")[0],
      }
      await saveCheckpoint(manifestPath, checkpoint)
      results.push({
        key: item.key,
        kind: item.kind,
        describe: item.describe,
        status,
        detail: result.stderr.trim().split("\n")[0],
      })
      if (status === "unknown") {
        unknownSeen = true
        halted = true
      } else {
        failedSeen = true
        halted = !continueOnFailure
      }
    }

    if (issueApplied && identifier != null) {
      const view = await runner.run([
        "issue",
        "view",
        identifier,
        ...workspaceFlags,
        "--json",
      ])
      if (view.code === 0) {
        readBack[identifier] = JSON.parse(view.stdout)
      }
    }
  }

  const summary: Record<ItemStatus, number> = {
    applied: 0,
    failed: 0,
    unknown: 0,
    unattempted: 0,
    skipped: 0,
  }
  for (const item of results) summary[item.status] += 1

  const status: ApplyOutcome["status"] = unknownSeen
    ? "stopped-on-unknown"
    : conflictSeen
    ? "conflict"
    : failedSeen
    ? (halted ? "stopped-on-failure" : "completed-with-failures")
    : "completed"

  return {
    status,
    items: results,
    summary,
    createdIdentifiers: checkpoint.createdIdentifiers,
    readBack,
  }
}

export interface IssuePlan {
  operation: DeliveryIssue["operation"]
  target: string | null
  fields: FieldPlan[]
  items: Array<{ key: string; kind: ItemKind; describe: string }>
}

export interface PlanOutcome {
  status: "ready" | "conflict"
  workspace: string
  issues: IssuePlan[]
  files: Array<
    Pick<ManifestFile, "reference" | "size" | "contentType" | "sha256">
  >
}

/**
 * The zero-write preview: read-only resolution of every update target plus
 * the full local file inventory. Optional by design — apply performs the same
 * validation and reads before its first mutation, so plan is for humans and
 * agents who want to see the complete delivery before consenting to it.
 */
export async function planManifest(
  context: ApplyContext,
): Promise<PlanOutcome> {
  const { loaded, runner } = context
  const { manifest } = loaded
  const issues: IssuePlan[] = []
  let conflict = false
  const workspaceFlags = await verifyEnvKeyOrganization(context)

  for (const [issueIndex, issue] of manifest.issues.entries()) {
    const items = await expandIssue(
      issue,
      issueIndex,
      workspaceFlags,
      loaded.files,
    )
    let fields: FieldPlan[] = []
    if (issue.operation === "update" && issue.set != null) {
      const view = await runner.run([
        "issue",
        "view",
        issue.identifier as string,
        ...workspaceFlags,
        "--json",
      ])
      if (view.code !== 0) {
        throw new CliError(
          `Failed to read ${issue.identifier}: ${
            view.stderr.trim().split("\n")[0]
          }`,
        )
      }
      const remote = extractRemoteFields(JSON.parse(view.stdout))
      fields = planFields(
        issue.set,
        issue.base,
        remote,
        (set) =>
          set.descriptionFile != null
            ? readDescriptionFile(loaded, set.descriptionFile)
            : set.description,
      )
      if (fields.some((plan) => plan.verdict === "conflict")) conflict = true
    }
    issues.push({
      operation: issue.operation,
      target: issue.identifier ?? null,
      fields,
      items: items.map(({ key, kind, describe }) => ({ key, kind, describe })),
    })
  }

  return {
    status: conflict ? "conflict" : "ready",
    workspace: manifest.workspace,
    issues,
    files: [...loaded.files.values()].map((
      { reference, size, contentType, sha256 },
    ) => ({ reference, size, contentType, sha256 })),
  }
}

function readDescriptionFile(
  loaded: LoadedManifest,
  reference: string,
): string {
  const file = loaded.files.get(reference)
  if (file == null) {
    throw new CliError(`Manifest file inventory missing ${reference}`)
  }
  return Deno.readTextFileSync(file.resolvedPath)
}
