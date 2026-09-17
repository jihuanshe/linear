export function getPagerCommand(): { command: string; args: string[] } {
  // Respect user's PAGER environment variable
  const userPager = Deno.env.get("PAGER")
  if (userPager) {
    // Split the pager command to handle cases like "less -R" or "more"
    const parts = userPager.trim().split(/\s+/)
    return {
      command: parts[0],
      args: parts.slice(1),
    }
  }

  return Deno.build.os === "windows"
    ? { command: "more", args: [] }
    : { command: "less", args: ["-R", "-X"] }
}

/**
 * Pipe output to appropriate pager with color support
 */
export async function pipeToUserPager(content: string): Promise<void> {
  const pagerConfig = getPagerCommand()

  try {
    const process = new Deno.Command(pagerConfig.command, {
      args: pagerConfig.args,
      stdin: "piped",
      stdout: "inherit",
      stderr: "inherit",
    })

    const child = process.spawn()
    const writer = child.stdin.getWriter()

    await writer.write(new TextEncoder().encode(content))
    await writer.close()

    const status = await child.status
    if (!status.success) {
      console.log(content)
    }
  } catch {
    console.log(content)
  }
}

/**
 * Determine if output should be paged based on content length and terminal size
 */
export function shouldUsePager(
  outputLines: string[],
  usePager: boolean,
): boolean {
  if (!usePager || !Deno.stdout.isTerminal()) {
    return false
  }

  try {
    const { rows: terminalHeight } = Deno.consoleSize()
    return outputLines.length > terminalHeight - 2 // Leave some space for shell prompt
  } catch {
    // If we can't get console size (e.g., in tests), don't use pager for short content
    return outputLines.length > 50 // Fallback threshold
  }
}
