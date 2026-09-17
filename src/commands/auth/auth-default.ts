import { Command } from "@cliffy/command"
import { withUsageMetadata } from "../usage.ts"
import { Select } from "../../utils/prompt.ts"
import {
  getDefaultWorkspace,
  getWorkspaces,
  hasWorkspace,
  setDefaultWorkspace,
} from "../../credentials.ts"
import { AuthError, handleError, NotFoundError } from "../../utils/errors.ts"

export const defaultCommand = withUsageMetadata(new Command(), {
  writes: true,
  interactive: true,
})
  .name("default")
  .description("Set the default workspace by locally saved workspace slug")
  .arguments("[slug:string]")
  .action(async (_options, slug?: string) => {
    try {
      const workspaces = getWorkspaces()

      if (workspaces.length === 0) {
        throw new AuthError("No workspaces configured", {
          suggestion: "Run `linear auth login` to add a workspace",
        })
      }

      const currentDefault = getDefaultWorkspace()

      // If no workspace specified, prompt to select one
      if (slug == null && workspaces.length === 1) {
        slug = workspaces[0]
      } else if (slug == null) {
        slug = await Select.prompt({
          message: "Select default workspace",
          options: workspaces.map((ws) => ({
            name: ws === currentDefault ? `${ws} (current)` : ws,
            value: ws,
          })),
        })
      }

      if (!hasWorkspace(slug)) {
        throw new NotFoundError("Workspace", slug, {
          suggestion: `Available workspaces: ${workspaces.join(", ")}`,
        })
      }

      if (slug === currentDefault) {
        console.log(`"${slug}" is already the default workspace`)
        return
      }

      await setDefaultWorkspace(slug)
      console.log(`Default workspace set to: ${slug}`)
    } catch (error) {
      handleError(error, "Failed to set default workspace")
    }
  })
