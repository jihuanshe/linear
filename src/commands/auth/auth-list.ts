import { Command } from "@cliffy/command"
import { underline } from "@std/fmt/colors"
import { getDefaultWorkspace, getWorkspaces } from "../../credentials.ts"
import { handleError } from "../../utils/errors.ts"
import { withTerminalColors } from "../../utils/terminal.ts"

export const listCommand = new Command()
  .name("list")
  .description(
    "List locally configured workspaces without validating credentials",
  )
  .action(() => {
    try {
      const workspaces = getWorkspaces()
      if (workspaces.length === 0) {
        console.log("No workspaces configured")
        console.log("Run `linear auth login` to add a workspace")
        return
      }
      const defaultWorkspace = getDefaultWorkspace()
      withTerminalColors(
        Deno.stdout,
        () =>
          console.log(
            underline("  WORKSPACE (* default; credentials not validated)"),
          ),
      )
      for (const workspace of workspaces) {
        console.log(
          `${workspace === defaultWorkspace ? "* " : "  "}${workspace}`,
        )
      }
    } catch (error) {
      handleError(error, "Failed to list workspaces")
    }
  })
