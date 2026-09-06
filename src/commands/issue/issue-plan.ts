import { Command } from "@cliffy/command"
import {
  type PlanContent,
  planManifest,
  type PlanOutcome,
  selfExecRunner,
} from "../../delivery/engine.ts"
import { loadManifest } from "../../delivery/manifest.ts"
import { handleError } from "../../utils/errors.ts"
import { withUsageMetadata } from "../usage.ts"

// `issue plan` validates a delivery manifest without remote writes, reads each
// update target, and reports the three-way field verdicts used by apply.

function formatContent(content: PlanContent): string {
  if (content.source === "inline") {
    return `inline Markdown (${content.size}B)`
  }
  return `file ${content.reference} (${content.size}B, ${content.contentType}, sha256 ${
    content.sha256.slice(0, 12)
  }…)`
}

function formatValue(value: unknown): string {
  return JSON.stringify(value)
}

export function formatPlan(plan: PlanOutcome): string {
  const lines: string[] = [
    `workspace: ${plan.workspace}`,
    `status: ${plan.status}`,
  ]
  for (const issue of plan.issues) {
    lines.push(
      "",
      `${issue.operation} ${issue.target ?? "(new issue)"}`,
    )
    if (issue.drift != null) {
      lines.push(`  refused: ${issue.drift}`)
    }
    if (issue.summary.team != null) {
      lines.push(`  team: ${issue.summary.team}`)
    }
    if (issue.operation === "create" && issue.summary.set != null) {
      const {
        title,
        description,
        priority,
        state,
        assignee,
        labels,
        project,
        parent,
      } = issue.summary.set
      const entries: Array<[string, unknown]> = [
        ["title", title],
        ["priority", priority],
        ["state", state],
        ["assignee", assignee],
        ["labels", labels],
        ["project", project],
        ["parent", parent],
      ]
      for (const [name, value] of entries) {
        if (value !== undefined) lines.push(`  ${name}: ${formatValue(value)}`)
      }
      if (description != null) {
        lines.push(`  description: ${formatContent(description)}`)
      }
    }
    for (const field of issue.fields) {
      const parts = [
        `  ${field.field}: ${field.verdict}`,
      ]
      if (field.verdict !== "idempotent") {
        parts.push(
          `    desired: ${JSON.stringify(field.desired)}`,
          `    remote:  ${JSON.stringify(field.remote)}`,
        )
        if ("base" in field) {
          parts.push(`    base:    ${JSON.stringify(field.base)}`)
        }
      }
      lines.push(...parts)
    }
    for (const [index, comment] of (issue.summary.comments ?? []).entries()) {
      lines.push(`  comment ${index + 1}:`)
      if (comment.body != null) {
        lines.push(`    body: ${formatContent(comment.body)}`)
      }
      if (comment.files.length > 0 || comment.public) {
        lines.push(
          `    uploads: ${comment.public ? "public" : "private"}`,
        )
      }
      for (const file of comment.files) {
        lines.push(
          `    file: ${file.reference} (${file.size}B, ${file.contentType}, sha256 ${
            file.sha256.slice(0, 12)
          }…)`,
        )
      }
    }
    for (const attachment of issue.summary.attachments ?? []) {
      const title = attachment.title == null
        ? ""
        : ` as ${JSON.stringify(attachment.title)}`
      lines.push(
        attachment.kind === "url"
          ? `  attachment: url ${attachment.url}${title}`
          : `  attachment: file ${attachment.path}${title}`,
      )
    }
    for (const relation of issue.summary.relations ?? []) {
      lines.push(
        `  relation: ${relation.type} ${relation.issue} — ${relation.verdict}${
          relation.detail == null ? "" : ` (${relation.detail})`
        }`,
      )
    }
    lines.push("  execution:")
    for (const item of issue.items) {
      lines.push(`    ${item.kind}: ${item.describe}`)
    }
  }
  if (plan.files.length > 0) {
    lines.push("", "files:")
    for (const file of plan.files) {
      lines.push(
        `  ${file.reference} (${file.size}B, ${file.contentType}, sha256 ${
          file.sha256.slice(0, 12)
        }…)`,
      )
    }
  }
  lines.push(
    "",
    "apply: linear issue apply --file <manifest> --confirm-workspace <slug>",
  )
  return lines.join("\n")
}

export const issuePlanCommand = withUsageMetadata(
  new Command()
    .description(
      "Preview an Issue delivery manifest with zero remote writes (fields, comments, files, attachments, relations)",
    )
    .option("-f, --file <path:string>", "Delivery manifest path", {
      required: true,
    })
    .option("--json", "Output the plan as JSON")
    .action(async ({ file, json }) => {
      try {
        const loaded = await loadManifest(file)
        const plan = await planManifest({
          loaded,
          runner: selfExecRunner(),
          envAuthenticated: Deno.env.get("LINEAR_API_KEY") != null,
        })
        console.log(
          json ? JSON.stringify(plan, null, 2) : formatPlan(plan),
        )
      } catch (error) {
        handleError(error, "Failed to plan delivery")
      }
    }),
  {},
)
