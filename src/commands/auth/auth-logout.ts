import { Command } from "@cliffy/command"
import { withUsageMetadata } from "../usage.ts"
import { Confirm, Select } from "../../utils/prompt.ts"
import {
  getDefaultWorkspace,
  getWorkspaces,
  hasWorkspace,
  removeCredential,
} from "../../credentials.ts"
import { AuthError, handleError, NotFoundError } from "../../utils/errors.ts"

export const logoutCommand = withUsageMetadata(new Command(), {
  writes: true,
  interactive: true,
})
  .name("logout")
  .description("Remove a workspace credential by locally saved workspace slug")
  .arguments("[slug:string]")
  .option("-y, --yes", "Skip confirmation prompt")
  .action(async (options, slug?: string) => {
    try {
      const workspaces = getWorkspaces()

      if (workspaces.length === 0) {
        throw new AuthError("No workspaces configured")
      }

      // If no workspace specified, prompt to select one
      if (!slug) {
        if (workspaces.length === 1) {
          slug = workspaces[0]
        } else {
          const defaultWorkspace = getDefaultWorkspace()
          slug = await Select.prompt({
            message: "Select workspace to remove",
            options: workspaces.map((ws) => ({
              name: ws === defaultWorkspace ? `${ws} (default)` : ws,
              value: ws,
            })),
          })
        }
      }

      if (!hasWorkspace(slug)) {
        throw new NotFoundError("Workspace", slug)
      }

      // Confirm removal unless --yes is specified
      if (!options.yes) {
        const confirmed = await Confirm.prompt({
          message: `Remove credentials for workspace "${slug}"?`,
          default: false,
        })

        if (!confirmed) {
          console.log("Cancelled")
          return
        }
      }

      await removeCredential(slug)
      console.log(`Removed credentials for workspace: ${slug}`)

      const remaining = getWorkspaces()
      if (remaining.length > 0) {
        const newDefault = getDefaultWorkspace()
        if (newDefault) {
          console.log(`  Default workspace is now: ${newDefault}`)
        }
      }
    } catch (error) {
      handleError(error, "Failed to logout")
    }
  })
