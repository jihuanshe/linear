import { Command } from "@cliffy/command"
import {
  planManifest,
  type PlanOutcome,
  selfExecRunner,
} from "../../delivery/engine.ts"
import { loadManifest } from "../../delivery/manifest.ts"
import { handleError } from "../../utils/errors.ts"
import { withUsageMetadata } from "../usage.ts"

// `issue plan` previews a delivery manifest with zero remote writes: it
// validates the manifest and every referenced file, reads each update
// target's current state, and shows exactly what apply would do — including
// three-way field verdicts, so a conflict a colleague created while the
// caller prepared material is visible before anything is written. Plan is
// optional: apply repeats this validation itself (design:
// docs/agent-interface-architecture.md, "`plan`").

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
    for (const item of issue.items) {
      lines.push(`  ${item.kind}: ${item.describe}`)
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
