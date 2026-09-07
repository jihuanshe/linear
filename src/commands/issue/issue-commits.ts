import { Command } from "@cliffy/command"
import { getIssueId, getIssueIdentifier } from "../../utils/linear.ts"
import { getVcs } from "../../utils/vcs.ts"
import {
  CliError,
  handleError,
  isClientError,
  isNotFoundError,
  NotFoundError,
  ValidationError,
} from "../../utils/errors.ts"

export const commitsCommand = new Command()
  .name("commits")
  .description("Show all commits for a Linear issue (jj only)")
  .arguments("[issueId:string]")
  .action(async (_options, issueId) => {
    try {
      const vcs = getVcs()

      if (vcs !== "jj") {
        throw new ValidationError(
          "commits is only supported with jj-vcs",
          { suggestion: "This command requires jujutsu (jj) version control." },
        )
      }

      const resolvedId = await getIssueIdentifier(issueId)
      if (!resolvedId) {
        throw new ValidationError(
          "Could not determine issue identifier",
          { suggestion: "Please provide an issue identifier like 'ENG-123'." },
        )
      }

      // Verify the issue exists in Linear
      let linearIssueId: string | undefined
      try {
        linearIssueId = await getIssueId(resolvedId)
      } catch (error) {
        if (isClientError(error) && isNotFoundError(error)) {
          throw new NotFoundError("Issue", resolvedId)
        }
        throw error
      }
      if (!linearIssueId) {
        throw new NotFoundError("Issue", resolvedId)
      }

      // Match a whole identifier, not FXA-10 or OTHERFXA-1 when asking for FXA-1.
      // JSON escaping preserves the regex backslashes through jj's string parser.
      const revset = `description(regex:${
        JSON.stringify(`(?m)^Linear-issue:.*\\b${resolvedId}\\b`)
      })`

      // First check if any commits exist
      const checkProcess = new Deno.Command("jj", {
        args: ["log", "-r", revset, "-T", "commit_id", "--no-graph"],
        stdout: "piped",
        stderr: "piped",
      })
      const checkResult = await checkProcess.output()
      if (!checkResult.success) {
        throw new CliError("Failed to query jj commits", {
          suggestion: new TextDecoder().decode(checkResult.stderr).trim(),
        })
      }
      const commitIds = new TextDecoder().decode(checkResult.stdout).trim()

      if (!commitIds) {
        throw new NotFoundError("Commits", resolvedId)
      }

      // Show the commits with full details
      const process = new Deno.Command("jj", {
        args: [
          "log",
          "-r",
          revset,
          "-p",
          "--git",
          "--no-graph",
          "-T",
          "builtin_log_compact_full_description",
        ],
        stdout: "inherit",
        stderr: "inherit",
      })

      const { code } = await process.output()
      Deno.exit(code)
    } catch (error) {
      handleError(error, "Failed to show commits")
    }
  })
