import { Command } from "@cliffy/command"
import { withUsageMetadata } from "./usage.ts"
import { prompt, Select } from "../utils/prompt.ts"
import { stringify } from "@std/toml"
import { gql } from "../__codegen__/gql.ts"
import { getGraphQLClient } from "../utils/graphql.ts"
import { getDefaultWorkspace, getWorkspaces } from "../credentials.ts"
import {
  getCliWorkspace,
  getOption,
  getProjectConfigPath,
  loadConfig,
  setCliWorkspace,
} from "../config.ts"
import {
  AuthError,
  handleError,
  NotFoundError,
  ValidationError,
} from "../utils/errors.ts"

const configQuery = gql(`
  query Config {
    viewer {
      organization {
        urlKey
      }
    }
    teams {
      nodes {
        id
        key
        name
      }
    }
  }
`)

export const configCommand = withUsageMetadata(new Command(), {
  writes: true,
  interactive: true,
})
  .name("config")
  .description("Interactively generate .linear.toml configuration")
  .action(async () => {
    try {
      loadConfig()
      const filePath = getProjectConfigPath()
      try {
        await Deno.lstat(filePath)
        throw new ValidationError(
          `Configuration already exists at ${filePath}`,
          {
            suggestion:
              "Edit the existing file; the config wizard never overwrites it.",
          },
        )
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error
      }
      console.log(`
██      ██ ███    ██ ███████  █████  ██████      ██████ ██      ██
██      ██ ████   ██ ██      ██   ██ ██   ██    ██      ██      ██
██      ██ ██ ██  ██ █████   ███████ ██████     ██      ██      ██
██      ██ ██  ██ ██ ██      ██   ██ ██   ██    ██      ██      ██
███████ ██ ██   ████ ███████ ██   ██ ██   ██     ██████ ███████ ██
`)

      const hasExplicitApiKey = Deno.env.get("LINEAR_API_KEY") != null ||
        getCliWorkspace() != null || getOption("workspace") != null

      if (!hasExplicitApiKey) {
        const workspaces = getWorkspaces()
        if (workspaces.length === 0) {
          throw new AuthError("No authentication configured", {
            suggestion: "Run `linear auth login` to add a workspace.",
          })
        }

        if (workspaces.length === 1) {
          // Single workspace - use automatically
          setCliWorkspace(workspaces[0])
        } else {
          // Multiple workspaces - prompt to select
          const defaultWorkspace = getDefaultWorkspace()
          const selected = await Select.prompt({
            message: "Select workspace:",
            options: workspaces.map((ws) => ({
              name: ws + (ws === defaultWorkspace ? " (default)" : ""),
              value: ws,
            })),
            default: defaultWorkspace,
          })
          setCliWorkspace(selected)
        }
      }

      const client = getGraphQLClient()
      const result = await client.request(configQuery)
      const workspace = result.viewer.organization.urlKey
      const teams = result.teams.nodes
      // Sort teams alphabetically by name (case insensitive)
      teams.sort((a, b) =>
        a.name.toLowerCase().localeCompare(b.name.toLowerCase())
      )

      const selectedTeamId = await Select.prompt({
        message: "Select a team:",
        search: true,
        searchLabel: "Search teams",
        options: teams.map((team) => ({
          name: `${team.name} (${team.key})`,
          value: team.id,
        })),
      })

      const team = teams.find((t) => t.id === selectedTeamId)

      if (!team) {
        throw new NotFoundError("Team", selectedTeamId)
      }

      const responses = await prompt([
        {
          name: "sort",
          message: "Select sort order:",
          type: Select,
          options: [
            { name: "manual", value: "manual" },
            { name: "priority", value: "priority" },
          ],
        },
      ])
      const teamKey = team.key
      const sortChoice = responses.sort

      if (getProjectConfigPath() !== filePath) {
        throw new ValidationError(
          "Configuration target changed while prompting; no file was written",
        )
      }

      const tomlContent = `# linear cli
# https://github.com/jihuanshe/linear

${stringify({ workspace, team_id: teamKey, issue_sort: sortChoice })}
`

      await Deno.writeTextFile(filePath, tomlContent, { createNew: true })
      console.log("Configuration written to", filePath)
    } catch (error) {
      handleError(error, "Failed to generate configuration")
    }
  })
