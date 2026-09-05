import { encodeHex } from "@std/encoding/hex"
import { fromFileUrl } from "@std/path"
import { CliError, ValidationError } from "../utils/errors.ts"
import {
  EMPTY_ISSUE_RELATION_SNAPSHOT,
  extractIssueRelationSnapshot,
  type IssueRelationPlan,
  planIssueRelations,
} from "../utils/linear.ts"
import type {
  DeliveryAttachment,
  DeliveryBase,
  DeliveryIssue,
  DeliverySet,
  LoadedManifest,
  ManifestFile,
} from "./manifest.ts"
import { prepareCheckpoint, saveCheckpoint } from "./checkpoint.ts"

// Each delivery step invokes this CLI's commands so name resolution,
// validation, and output semantics stay with their command owners.

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
  identifier?: string
  archivedAt?: string | null
  trashed?: boolean | null
  title?: string
  description?: string | null
  priority?: number | null
  state?: string
  stateAliases?: string[]
  assignee?: { name?: string; displayName?: string } | null
  labels?: string[]
  labelsComplete?: boolean
  project?: string | null
  projectAliases?: string[]
  parent?: string | null
}

export function extractRemoteFields(view: unknown): RemoteFields {
  const data = view as Record<string, unknown>
  const nested = (value: unknown, key: string): unknown =>
    value == null ? null : (value as Record<string, unknown>)[key]
  const labelsNode = nested(data.labels, "nodes")
  const labelsPageInfo = nested(data.labels, "pageInfo")
  const stateAliases = [nested(data.state, "name"), nested(data.state, "type")]
    .filter((value): value is string => typeof value === "string")
  const projectAliases = [
    nested(data.project, "name"),
    nested(data.project, "id"),
    nested(data.project, "slugId"),
  ].filter((value): value is string => typeof value === "string")
  return {
    identifier: data.identifier as string | undefined,
    archivedAt: (data.archivedAt ?? null) as string | null,
    trashed: (data.trashed ?? null) as boolean | null,
    title: data.title as string | undefined,
    description: (data.description ?? null) as string | null,
    priority: data.priority === 0
      ? null
      : (data.priority ?? null) as number | null,
    state: stateAliases[0],
    stateAliases,
    assignee: (data.assignee ?? null) as RemoteFields["assignee"],
    labels: Array.isArray(labelsNode)
      ? labelsNode.map((node) => nested(node, "name") as string)
      : undefined,
    labelsComplete: labelsPageInfo == null
      ? undefined
      : nested(labelsPageInfo, "hasNextPage") !== true,
    project: projectAliases[0] ?? null,
    projectAliases,
    parent: (nested(data.parent, "identifier") ?? null) as string | null,
  }
}

/**
 * Object-level guards inherited from the batch-write Skill: an update must
 * target exactly the issue the manifest names — never a resolved alias
 * (rename or team move), an archived issue, or a trashed one. Field-level
 * base comparison cannot see these, so they refuse before any planning.
 * Fields absent from an older view payload skip their check instead of
 * failing closed.
 */
export function objectDrift(
  requested: string,
  remote: RemoteFields,
): string | null {
  if (
    remote.identifier != null &&
    remote.identifier.toUpperCase() !== requested.toUpperCase()
  ) {
    return `resolved to ${remote.identifier} (renamed or moved to another team)`
  }
  if (remote.trashed === true) return "issue is in the trash"
  if (remote.archivedAt != null) return "issue is archived"
  return null
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
      if (remote.labelsComplete === false) {
        throw new ValidationError(
          "Issue label set exceeds the issue view pagination boundary",
          {
            suggestion:
              "Reduce the issue's labels before using a delivery manifest to replace the complete label set",
          },
        )
      }
      const a = [...(manifestValue as string[] ?? [])].sort()
      const b = [...(remoteValue as string[] ?? [])].sort()
      return a.length === b.length &&
        a.every((label, index) => label === b[index])
    }
    case "state":
      return typeof manifestValue === "string" &&
        (remote.stateAliases ??
          (typeof remoteValue === "string" ? [remoteValue] : [])).some((
            alias,
          ) => alias.toLowerCase() === manifestValue.toLowerCase())
    case "project":
      if (manifestValue == null || remoteValue == null) {
        return manifestValue == null && remoteValue == null
      }
      return (remote.projectAliases ?? [remoteValue as string]).some((alias) =>
        alias === manifestValue
      )
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
 * refuses to overwrite their work. This is an optimistic guard, not a
 * server-side compare-and-set: Linear's issueUpdate takes no version
 * precondition, so a narrow race window remains between read and write.
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
    const hasBase = Object.hasOwn(base ?? {}, field)
    const baseValue = base?.[field]
    let verdict: FieldVerdict
    if (fieldEquals(field, desired, remote)) {
      verdict = "idempotent"
    } else if (hasBase && fieldEquals(field, baseValue, remote)) {
      verdict = "write"
    } else {
      verdict = "conflict"
    }
    plans.push({
      field,
      desired,
      ...(hasBase ? { base: baseValue } : {}),
      remote: remote[field] ?? null,
      verdict,
    })
  }
  return plans
}

type ItemKind = "fields" | "comment" | "attachment" | "relation"
type ItemStatus =
  | "applied"
  | "failed"
  | "unknown"
  | "unattempted"
  | "skipped"

interface BuiltCommand {
  args: string[]
  cleanup?: () => Promise<void>
}

interface DeliveryItem {
  key: string
  kind: ItemKind
  subIndex: number
  buildCommand: (identifier: string) => BuiltCommand | Promise<BuiltCommand>
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
async function expandIssue(
  issue: DeliveryIssue,
  issueIndex: number,
  workspaceFlags: string[],
  files: Map<string, ManifestFile>,
): Promise<DeliveryItem[]> {
  const items: DeliveryItem[] = []
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
      kind: "fields",
      subIndex: 0,
      describe: issue.operation === "create"
        ? `create issue in team ${issue.team}`
        : `update fields of ${issue.identifier}`,
      buildCommand: (identifier) => {
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
          return {
            args: [
              "issue",
              "create",
              "--no-interactive",
              "--team",
              issue.team as string,
              ...ws,
              ...flags,
              "--json",
            ],
          }
        }
        return {
          args: ["issue", "update", identifier, ...ws, ...flags, "--json"],
        }
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
      kind: "comment",
      subIndex,
      describe: `add comment ${subIndex + 1} with ${
        (comment.files ?? []).length
      } file(s)`,
      buildCommand: async (identifier) => {
        const args = ["issue", "comment", "add", identifier, ...ws]
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
          ...(temp == null ? {} : {
            cleanup: async () => {
              await Deno.remove(temp).catch(() => {})
            },
          }),
        }
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
      kind: "attachment",
      subIndex,
      describe: attachment.kind === "url"
        ? `link ${attachment.url}`
        : `attach ${attachment.path}`,
      buildCommand: (identifier) => ({
        args: attachment.kind === "url"
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
      }),
    })
  }

  for (const [subIndex, relation] of (issue.relations ?? []).entries()) {
    const hash = await itemHash({ relation })
    items.push({
      key: `${issueIndex}:relation:${subIndex}:${hash}`,
      kind: "relation",
      subIndex,
      describe: `relate ${relation.type} ${relation.issue}`,
      buildCommand: (identifier) => ({
        args: [
          "issue",
          "relation",
          "add",
          identifier,
          relation.type,
          relation.issue,
          ...ws,
        ],
      }),
    })
  }

  return items
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
    | "applied-unverified"
    | "completed-with-failures"
    | "stopped-on-failure"
    | "stopped-on-unknown"
    | "conflict"
  items: ItemResult[]
  summary: Record<ItemStatus, number>
  createdIdentifiers: Record<string, string>
  verification: VerificationResult[]
  readBack: Record<string, unknown>
}

export interface VerificationResult {
  issueIndex: number
  target: string
  status: "verified" | "failed"
  detail?: string
  url?: string
}

interface ReadBackResult {
  verification: VerificationResult
  data?: Record<string, unknown>
}

async function readBackIssue(
  runner: CommandRunner,
  issueIndex: number,
  identifier: string,
  workspaceFlags: string[],
): Promise<ReadBackResult> {
  const failed = (detail: string): ReadBackResult => ({
    verification: {
      issueIndex,
      target: identifier,
      status: "failed",
      detail,
    },
  })

  try {
    const view = await runner.run([
      "issue",
      "view",
      identifier,
      ...workspaceFlags,
      "--json",
    ])
    if (view.code !== 0) {
      return failed(
        view.stderr.trim().split("\n")[0] ||
          `issue view exited with code ${view.code}`,
      )
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(view.stdout)
    } catch (error) {
      return failed(
        `issue view returned invalid JSON: ${(error as Error).message}`,
      )
    }
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return failed("issue view returned no issue object")
    }

    const data = parsed as Record<string, unknown>
    const readIdentifier = data.identifier
    if (
      typeof readIdentifier !== "string" ||
      readIdentifier.toUpperCase() !== identifier.toUpperCase()
    ) {
      return failed(
        `issue view returned ${
          typeof readIdentifier === "string" ? readIdentifier : "no identifier"
        }`,
      )
    }

    return {
      verification: {
        issueIndex,
        target: identifier,
        status: "verified",
        ...(typeof data.url === "string" ? { url: data.url } : {}),
      },
      data,
    }
  } catch (error) {
    return failed((error as Error).message)
  }
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

async function verifyWorkspaceIdentity(
  context: ApplyContext,
): Promise<string[]> {
  const { manifest } = context.loaded
  // Credential resolution can override --workspace: LINEAR_API_KEY rejects the
  // flag outright, and a project .linear.toml api_key silently outranks it. So
  // the guard never trusts the flag alone — it asks whoami with exactly the
  // flags the child commands will get and requires the resolved workspace to
  // match the manifest before any remote work.
  const workspaceFlags = context.envAuthenticated === true
    ? []
    : ["--workspace", manifest.workspace]
  const whoami = await context.runner.run([
    "auth",
    "whoami",
    ...workspaceFlags,
    "--json",
  ])
  if (whoami.code !== 0) {
    throw new ValidationError(
      `Cannot verify the resolved workspace: ${
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
      `Manifest targets workspace ${manifest.workspace} but the resolved credentials belong to ${
        urlKey ?? "an unknown workspace"
      }`,
      {
        suggestion:
          "Check LINEAR_API_KEY and any project .linear.toml api_key before re-running",
      },
    )
  }
  return workspaceFlags
}

export async function applyManifest(
  context: ApplyContext,
): Promise<ApplyOutcome> {
  const { loaded, runner } = context
  const { manifest, manifestPath } = loaded
  const progress = context.onProgress ?? (() => {})
  const workspaceFlags = await verifyWorkspaceIdentity(context)

  const expansions: DeliveryItem[][] = []
  for (const [issueIndex, issue] of manifest.issues.entries()) {
    expansions.push(
      await expandIssue(issue, issueIndex, workspaceFlags, loaded.files),
    )
  }

  const checkpoint = await prepareCheckpoint(
    manifestPath,
    expansions.flat().map((item) => item.key),
  )

  const results: ItemResult[] = []
  const verification: VerificationResult[] = []
  const readBack: Record<string, unknown> = {}
  // `halted` controls whether further items run; the flags remember
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

    // Update issues with pending work need current remote values before their
    // first mutation. An all-applied checkpoint skips this preflight and goes
    // straight to final verification: otherwise a transient read-back failure
    // would be misclassified as a mutation preflight failure on resume.
    let remote: RemoteFields | null = null
    let remoteView: unknown = null
    let issueHalted = false
    const hasPendingItems = items.some((item) =>
      checkpoint.items[item.key]?.status !== "applied"
    )
    if (issue.operation === "update" && hasPendingItems) {
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
        remoteView = JSON.parse(view.stdout)
        remote = extractRemoteFields(remoteView)
        const drift = objectDrift(issue.identifier as string, remote)
        if (drift != null) {
          results.push({
            key: `${issueIndex}:fields:0:guard`,
            kind: "fields",
            describe: `refuse update of ${issue.identifier}`,
            status: "failed",
            detail: drift,
          })
          failedSeen = true
          halted = !continueOnFailure
          issueHalted = true
        }
      }
    }

    const relationPlans = new Map<number, IssueRelationPlan>()
    if (!issueHalted) {
      const pendingRelationItems = items.filter((item) =>
        item.kind === "relation" &&
        checkpoint.items[item.key]?.status !== "applied"
      )
      if (pendingRelationItems.length > 0) {
        const requests = pendingRelationItems.map((item) => {
          const request = issue.relations?.[item.subIndex]
          if (request == null) {
            throw new CliError(
              `Manifest relation ${item.subIndex} is missing from issue ${issueIndex}`,
            )
          }
          return request
        })
        const snapshot = issue.operation === "create"
          ? EMPTY_ISSUE_RELATION_SNAPSHOT
          : extractIssueRelationSnapshot(remoteView)
        const planned = planIssueRelations(requests, snapshot)
        for (const [index, plan] of planned.entries()) {
          relationPlans.set(pendingRelationItems[index].subIndex, plan)
        }
        if (planned.some((plan) => plan.verdict === "conflict")) {
          conflictSeen = true
          halted = !continueOnFailure
          issueHalted = true
        }
      }
    }

    let identifier = issue.identifier ??
      checkpoint.createdIdentifiers[String(issueIndex)] ?? null
    // Successful mutations and checkpoint skips both need a final read-back.
    // A verification failure never changes an applied checkpoint entry: the
    // write is known to have succeeded and must not be repeated merely because
    // its current view could not be fetched.
    let issueNeedsVerification = false

    for (const item of items) {
      const recorded = checkpoint.items[item.key]
      if (recorded?.status === "applied") {
        issueNeedsVerification = true
        results.push({
          key: item.key,
          kind: item.kind,
          describe: item.describe,
          status: "skipped",
          detail: "already applied per checkpoint",
        })
        continue
      }
      const relationPlan = item.kind === "relation"
        ? relationPlans.get(item.subIndex)
        : undefined
      if (relationPlan?.verdict === "conflict") {
        results.push({
          key: item.key,
          kind: item.kind,
          describe: item.describe,
          status: "failed",
          detail: `conflict: ${
            relationPlan.detail ?? "relation would replace an existing edge"
          }`,
        })
        continue
      }
      if (halted || issueHalted) {
        results.push({
          key: item.key,
          kind: item.kind,
          describe: item.describe,
          status: "unattempted",
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
          issueNeedsVerification = true
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

      if (
        relationPlan?.verdict === "idempotent" &&
        relationPlan.idempotentSource === "remote"
      ) {
        checkpoint.items[item.key] = { status: "applied", note: "idempotent" }
        await saveCheckpoint(manifestPath, checkpoint)
        issueNeedsVerification = true
        results.push({
          key: item.key,
          kind: item.kind,
          describe: item.describe,
          status: "applied",
          detail: "idempotent: equivalent relation already exists",
        })
        continue
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
      const command = await item.buildCommand(identifier ?? "")

      // Record the launch before the mutation goes out: a hard crash while
      // the child is in flight leaves an unknown entry, so the next run stops
      // for reconciliation instead of repeating a write that may have landed.
      checkpoint.items[item.key] = {
        status: "unknown",
        note: "in flight: launched but result not recorded",
      }
      await saveCheckpoint(manifestPath, checkpoint)
      let result: CommandResult
      try {
        result = await runner.run(command.args)
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
        await command.cleanup?.()
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
        issueNeedsVerification = true
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

    if (issueNeedsVerification && identifier != null) {
      const result = await readBackIssue(
        runner,
        issueIndex,
        identifier,
        workspaceFlags,
      )
      verification.push(result.verification)
      if (result.data != null) readBack[identifier] = result.data
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
    : verification.some((result) => result.status === "failed")
    ? "applied-unverified"
    : "completed"

  return {
    status,
    items: results,
    summary,
    createdIdentifiers: checkpoint.createdIdentifiers,
    verification,
    readBack,
  }
}

type PlanFile = Pick<
  ManifestFile,
  "reference" | "size" | "contentType" | "sha256"
>

export type PlanContent =
  | { source: "inline"; size: number }
  | ({ source: "file" } & PlanFile)

export type PlanSet = Omit<DeliverySet, "description" | "descriptionFile"> & {
  description?: PlanContent
}

export interface PlanComment {
  body?: PlanContent
  public: boolean
  files: PlanFile[]
}

export type PlanAttachment =
  | Extract<DeliveryAttachment, { kind: "url" }>
  | (Extract<DeliveryAttachment, { kind: "file" }> & { file: PlanFile })

export interface IssuePlanSummary {
  team?: string
  set?: PlanSet
  comments?: PlanComment[]
  attachments?: PlanAttachment[]
  relations?: IssueRelationPlan[]
}

export interface IssuePlan {
  operation: DeliveryIssue["operation"]
  target: string | null
  /** Object-level refusal (alias, archived, trashed); null when clean. */
  drift?: string | null
  fields: FieldPlan[]
  /** Concise request metadata; long Markdown is represented by source/size. */
  summary: IssuePlanSummary
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

function planFile(loaded: LoadedManifest, reference: string): PlanFile {
  const file = loaded.files.get(reference)
  if (file == null) {
    throw new CliError(`Manifest file inventory missing ${reference}`)
  }
  const { size, contentType, sha256 } = file
  return { reference, size, contentType, sha256 }
}

function planContent(
  loaded: LoadedManifest,
  inline: string | undefined,
  reference: string | undefined,
): PlanContent | undefined {
  if (reference != null) {
    return { source: "file", ...planFile(loaded, reference) }
  }
  if (inline != null) {
    return {
      source: "inline",
      size: new TextEncoder().encode(inline).length,
    }
  }
  return undefined
}

function summarizeIssue(
  loaded: LoadedManifest,
  issue: DeliveryIssue,
  relations: IssueRelationPlan[],
): IssuePlanSummary {
  let set: PlanSet | undefined
  if (issue.set != null) {
    const { description, descriptionFile, ...otherFields } = issue.set
    const content = planContent(loaded, description, descriptionFile)
    set = {
      ...otherFields,
      ...(content == null ? {} : { description: content }),
    }
  }

  const comments = (issue.comments ?? []).map((comment) => {
    const body = planContent(loaded, comment.body, comment.bodyFile)
    return {
      ...(body == null ? {} : { body }),
      public: comment.public === true,
      files: (comment.files ?? []).map((file) => planFile(loaded, file.path)),
    }
  })
  const attachments = (issue.attachments ?? []).map((attachment) =>
    attachment.kind === "file"
      ? { ...attachment, file: planFile(loaded, attachment.path) }
      : attachment
  )

  return {
    ...(issue.team == null ? {} : { team: issue.team }),
    ...(set == null ? {} : { set }),
    ...(comments.length === 0 ? {} : { comments }),
    ...(attachments.length === 0 ? {} : { attachments }),
    ...(relations.length === 0 ? {} : { relations }),
  }
}

/**
 * The zero-write preview: read-only resolution of every update target plus
 * the full local file inventory. Optional by design — apply performs the same
 * local validation, then reads each update target immediately before that
 * Issue's first mutation. Plan is for callers that want the complete remote
 * preview before consenting to sequential execution.
 */
export async function planManifest(
  context: ApplyContext,
): Promise<PlanOutcome> {
  const { loaded, runner } = context
  const { manifest } = loaded
  const issues: IssuePlan[] = []
  let conflict = false
  const workspaceFlags = await verifyWorkspaceIdentity(context)

  for (const [issueIndex, issue] of manifest.issues.entries()) {
    const items = await expandIssue(
      issue,
      issueIndex,
      workspaceFlags,
      loaded.files,
    )
    let fields: FieldPlan[] = []
    let drift: string | null = null
    let remoteView: unknown = null
    if (issue.operation === "update") {
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
      remoteView = JSON.parse(view.stdout)
      const remote = extractRemoteFields(remoteView)
      drift = objectDrift(issue.identifier as string, remote)
      if (drift != null) conflict = true
      if (issue.set != null) {
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
    }
    const relations = planIssueRelations(
      issue.relations ?? [],
      issue.operation === "create"
        ? EMPTY_ISSUE_RELATION_SNAPSHOT
        : extractIssueRelationSnapshot(remoteView),
    )
    if (relations.some((plan) => plan.verdict === "conflict")) conflict = true
    issues.push({
      operation: issue.operation,
      target: issue.identifier ?? null,
      drift,
      fields,
      summary: summarizeIssue(loaded, issue, relations),
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
