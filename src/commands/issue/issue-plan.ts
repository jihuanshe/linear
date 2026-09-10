import { Command } from "@cliffy/command"
import { planManifest, type PlanOutcome } from "../../delivery/engine.ts"
import { loadManifest } from "../../delivery/manifest.ts"
import { handleError } from "../../utils/errors.ts"
import { withUsageMetadata } from "../usage.ts"

export function formatPlan(plan: PlanOutcome): string {
  const lines = ["workspace: " + plan.workspace, "status: " + plan.status]
  for (const issue of plan.issues) {
    lines.push("", issue.operation + " " + (issue.target ?? "(new Issue)"))
    if (issue.error != null) {
      lines.push("  refused: " + issue.error.error.message)
    }
    for (const field of issue.fields) {
      lines.push("  " + field.field + ": " + field.verdict)
      if (field.verdict !== "idempotent") {
        lines.push(
          "    desired: " + JSON.stringify(field.desired),
          "    remote: " + JSON.stringify(field.remote),
        )
        if (field.base !== undefined) {
          lines.push("    base: " + JSON.stringify(field.base))
        }
      }
    }
    lines.push("  content: " + JSON.stringify(issue.content))
    for (const relation of issue.relations) {
      lines.push(
        "  relation: " + relation.type + " " + relation.issue + " — " +
          relation.verdict,
      )
    }
    for (const item of issue.items) {
      lines.push(
        "  " + (item.completed ? "completed: " : "next: ") + item.describe,
      )
    }
  }
  for (const file of plan.files) {
    lines.push(
      "file: " + file.reference + " (" + file.size + "B, sha256 " +
        file.sha256 + ")",
    )
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
      "Preview an Issue delivery using the same preparation as apply; no remote writes or checkpoint writes",
    )
    .option("-f, --file <path:string>", "Delivery manifest path", {
      required: true,
    })
    .option("--json", "Output the plan as JSON")
    .action(async ({ file, json }) => {
      try {
        const plan = await planManifest({ loaded: await loadManifest(file) })
        console.log(json ? JSON.stringify(plan, null, 2) : formatPlan(plan))
        if (plan.status !== "ready") Deno.exitCode = 1
      } catch (error) {
        handleError(error, "Failed to plan delivery")
      }
    }),
  {},
)
