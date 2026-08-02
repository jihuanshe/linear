import { initializeStdoutColors } from "./utils/terminal.ts"

if (import.meta.main) {
  initializeStdoutColors()
  const [{ ValidationError }, { cli }] = await Promise.all([
    import("@cliffy/command"),
    import("./cli.ts"),
  ])
  try {
    await cli.parse(Deno.args)
  } catch (error) {
    if (error instanceof ValidationError) {
      console.error(`error: ${error.message}`)
      Deno.exitCode = error.exitCode
    } else {
      throw error
    }
  }
}
