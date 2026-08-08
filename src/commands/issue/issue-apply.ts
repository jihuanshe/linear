import { Command } from "@cliffy/command"
import {
  applyManifest,
  type ApplyOutcome,
  selfExecRunner,
} from "../../delivery/engine.ts"
import { loadManifest } from "../../delivery/manifest.ts"
import { handleError, ValidationError } from "../../utils/errors.ts"
import { withUsageMetadata } from "../usage.ts"

// `issue apply` executes a delivery manifest sequentially through the CLI's
// own commands, reporting applied/failed/unknown/unattempted per requested
// item. --confirm-workspace must repeat the manifest's workspace: the flag is
// an execution guard against pointing a prepared manifest at the wrong
// workspace, not a substitute for the caller's authorization to write.
// Confirmed successes are checkpointed beside the manifest so a resumed run
// never repeats them; an unknown outcome blocks further runs until the
// checkpoint entry is explicitly reconciled.

export function formatApply(outcome: ApplyOutcome): string {
  const lines: string[] = [`status: ${outcome.status}`]
  for (const item of outcome.items) {
    lines.push(
      `  ${item.status.padEnd(12)}${item.describe}${
        item.detail == null ? "" : ` — ${item.detail}`
      }`,
    )
  }
  const created = Object.values(outcome.createdIdentifiers)
  if (created.length > 0) {
    lines.push("", `created: ${created.join(", ")}`)
  }
  return lines.join("\n")
}

export const issueApplyCommand = withUsageMetadata(
  new Command()
    .description(
      "Apply an Issue delivery manifest sequentially with per-item results and a resumable checkpoint",
    )
    .option("-f, --file <path:string>", "Delivery manifest path", {
      required: true,
    })
    .option(
      "--confirm-workspace <slug:string>",
      "Repeat the manifest's workspace slug to confirm the write target",
      { required: true },
    )
    .option("--json", "Output per-item results and read-back as JSON")
    .action(async ({ file, confirmWorkspace, json }) => {
      try {
        const loaded = await loadManifest(file)
        if (confirmWorkspace !== loaded.manifest.workspace) {
          throw new ValidationError(
            `--confirm-workspace ${confirmWorkspace} does not match manifest workspace ${loaded.manifest.workspace}`,
          )
        }
        const outcome = await applyManifest({
          loaded,
          runner: selfExecRunner(),
          onProgress: json ? undefined : (line) => console.error(line),
        })
        console.log(
          json ? JSON.stringify(outcome, null, 2) : formatApply(outcome),
        )
        if (outcome.status !== "completed") {
          Deno.exit(1)
        }
      } catch (error) {
        handleError(error, "Failed to apply delivery")
      }
    }),
  { writes: true, confirmationRequiredUnless: "--confirm-workspace" },
)
