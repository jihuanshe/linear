import { snapshotTest as cliffySnapshotTest } from "@cliffy/testing"
import { keyCommand } from "../../../src/commands/team/team-key.ts"

// Common Deno args for permissions
const denoArgs = ["--allow-all", "--quiet"]

// Test help output
await cliffySnapshotTest({
  name: "Team Key Command - Help Text",
  meta: import.meta,
  colors: false,
  args: ["--help"],
  denoArgs,
  async fn() {
    keyCommand.help({ colors: false })
    await keyCommand.parse()
  },
})

await cliffySnapshotTest({
  name: "Team Key Command - No Team Configured",
  meta: import.meta,
  colors: false,
  args: [],
  denoArgs,
  canFail: true,
  async fn() {
    const directory = await Deno.makeTempDir()
    const cwd = Deno.cwd()
    Deno.chdir(directory)
    Deno.env.delete("LINEAR_TEAM_ID")
    Deno.env.set("XDG_CONFIG_HOME", directory)
    Deno.env.set("APPDATA", directory)
    try {
      await keyCommand.parse()
    } finally {
      Deno.chdir(cwd)
      await Deno.remove(directory, { recursive: true })
    }
  },
})
