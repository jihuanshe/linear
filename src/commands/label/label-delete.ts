import { Command } from "@cliffy/command"
import { withUsageMetadata } from "../usage.ts"
import { Confirm, Select } from "../../utils/prompt.ts"
import { gql } from "../../__codegen__/gql.ts"
import type { GetLabelByNameQuery } from "../../__codegen__/graphql.ts"
import { getGraphQLClient } from "../../utils/graphql.ts"
import { getTeamKey } from "../../utils/linear.ts"
import { shouldShowSpinner } from "../../utils/hyperlink.ts"
import { completeConnection } from "../../utils/pagination.ts"
import { printWriteResult, setMachineOutput } from "../../utils/write-result.ts"
import {
  assertMutationSuccess,
  handleError,
  NotFoundError,
  ValidationError,
} from "../../utils/errors.ts"

const DeleteIssueLabel = gql(`
  mutation DeleteIssueLabel($id: String!) {
    issueLabelDelete(id: $id) {
      success
    }
  }
`)

const GetLabelByName = gql(`
  query GetLabelByName($name: String!, $after: String) {
    issueLabels(
      first: 100
      after: $after
      filter: {
        name: { eqIgnoreCase: $name }
      }
    ) {
      nodes {
        id
        name
        color
        team {
          key
          name
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`)

const GetLabelById = gql(`
  query GetLabelById($id: String!) {
    issueLabel(id: $id) {
      id
      name
      color
      team {
        key
        name
      }
    }
  }
`)

type Label = GetLabelByNameQuery["issueLabels"]["nodes"][number]

async function resolveLabelId(
  client: ReturnType<typeof getGraphQLClient>,
  nameOrId: string,
  teamKey?: string,
  json = false,
): Promise<Label | undefined> {
  // Try as UUID first
  if (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      nameOrId,
    )
  ) {
    const result = await client.request(GetLabelById, { id: nameOrId })
    return result.issueLabel ?? undefined
  }

  // Try as name
  const result = await client.request(GetLabelByName, { name: nameOrId })
  const connection = await completeConnection(
    result.issueLabels,
    async (after) => {
      const next = await client.request(GetLabelByName, {
        name: nameOrId,
        after,
      })
      return next.issueLabels
    },
    "label lookup",
  )
  let labels: Label[] = connection.nodes

  if (labels.length === 0) {
    return undefined
  }

  // If team is specified, filter by team
  if (teamKey) {
    const teamLabels = labels.filter(
      (l) => l.team?.key?.toLowerCase() === teamKey.toLowerCase(),
    )
    labels = teamLabels.length > 0 ? teamLabels : labels.filter((l) => !l.team)
    if (labels.length === 0) return undefined
  }

  // If multiple labels with same name exist, let user choose
  if (labels.length > 1) {
    if (json || !Deno.stdin.isTerminal()) {
      throw new ValidationError(
        `Multiple labels named "${nameOrId}" found`,
        { suggestion: "Use --team to disambiguate." },
      )
    }
    const options = labels.map((l) => ({
      name: `${l.name} (${l.team?.key || "Workspace"}) - ${l.color}`,
      value: l.id,
    }))

    const selectedId = await Select.prompt({
      message: `Multiple labels named "${nameOrId}" found. Which one?`,
      options,
    })

    return labels.find((l) => l.id === selectedId)
  }

  // Return first match (workspace labels typically)
  return labels[0]
}

export const deleteCommand = withUsageMetadata(new Command(), {
  writes: true,
  interactive: true,
  confirmationRequiredUnless: "--force",
  outputModes: ["human", "json"],
})
  .name("delete")
  .option("--json", "Output a JSON write result")
  .description("Delete an issue label")
  .arguments("<nameOrId:string>")
  .option(
    "-t, --team <teamKey:string>",
    "Team key to disambiguate labels with same name",
  )
  .option("-f, --force", "Skip confirmation prompt")
  .action(async ({ team: teamKey, force, json }, nameOrId) => {
    setMachineOutput(json ?? false)
    try {
      const client = getGraphQLClient()

      // Use configured team if not specified
      const effectiveTeamKey = teamKey || getTeamKey()

      // Resolve label
      const label = await resolveLabelId(
        client,
        nameOrId,
        effectiveTeamKey,
        json,
      )

      if (!label) {
        const suggestion = effectiveTeamKey
          ? `Searched in team ${effectiveTeamKey} and workspace.`
          : undefined
        throw new NotFoundError("Label", nameOrId, { suggestion })
      }

      const labelDisplay = `${label.name} (${label.team?.key || "Workspace"})`

      // Confirmation prompt unless --force is used
      if (!force) {
        if (json || !Deno.stdin.isTerminal()) {
          throw new ValidationError("Interactive confirmation required", {
            suggestion: "Use --force to skip confirmation.",
          })
        }
        const confirmed = await Confirm.prompt({
          message: `Are you sure you want to delete label "${labelDisplay}"?`,
          default: false,
        })

        if (!confirmed) {
          console.log("Deletion canceled")
          return
        }
      }

      const { Spinner } = await import("@std/cli/unstable-spinner")
      const showSpinner = !json && shouldShowSpinner()
      const spinner = showSpinner ? new Spinner() : null
      spinner?.start()

      try {
        const result = await client.request(DeleteIssueLabel, {
          id: label.id,
        })
        spinner?.stop()

        assertMutationSuccess(result?.issueLabelDelete, {
          id: label.id,
          result: result?.issueLabelDelete,
        })
        if (json) {
          printWriteResult({ id: label.id, success: true })
          return
        }
        console.log(`✓ Deleted label: ${labelDisplay}`)
      } catch (error) {
        spinner?.stop()
        throw error
      }
    } catch (error) {
      handleError(error, "Failed to delete label")
    }
  })
