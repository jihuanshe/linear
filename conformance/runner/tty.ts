/**
 * Run the executable on a pseudo-terminal and drive it like a user.
 *
 * A `tty` section is a script of `expect <text>` lines, which wait until the
 * terminal shows the text, and `send <keys>` lines, which type keys. Keys may
 * use \r, \n, \t, \e (escape), \xHH and \\. The pseudo-terminal comes from the
 * system `script` utility (util-linux or BSD); stdout and stderr share it, so
 * the transcript is reported as stdout with terminal control sequences removed.
 */

export interface TtyOutput {
  code: number
  stdout: string
  stderr: string
  timedOut: boolean
  problem?: string
}

const EXPECT_TIMEOUT_MS = 10_000

export function decodeKeys(text: string): string {
  return text.replace(
    /\\(r|n|t|e|\\|x([0-9a-fA-F]{2}))/g,
    (_, c: string, hex?: string) => {
      if (hex != null) return String.fromCharCode(parseInt(hex, 16))
      return { r: "\r", n: "\n", t: "\t", e: "\x1b", "\\": "\\" }[c]!
    },
  )
}

const ESC = "\u001b"
const BEL = "\u0007"
// Built from strings: lint rejects control characters in regex literals.
const OSC = new RegExp(`${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`, "g")
const CSI = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, "g")
const OTHER_ESCAPE = new RegExp(`${ESC}[@-_]`, "g")

/** Remove terminal control sequences and normalize line endings. */
export function cleanTranscript(raw: string): string {
  return raw
    .replace(OSC, "")
    .replace(CSI, "")
    .replace(OTHER_ESCAPE, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
}

function shellQuote(word: string): string {
  return `'${word.replaceAll("'", `'\\''`)}'`
}

export function ttySupported(): boolean {
  return Deno.build.os === "linux" || Deno.build.os === "darwin"
}

export async function executeTty(
  binary: string,
  argv: string[],
  env: Record<string, string>,
  cwd: string,
  script: string,
  timeoutMs: number,
): Promise<TtyOutput> {
  // A fixed terminal size keeps prompt layout reproducible.
  const command = `stty cols 120 rows 40; exec ${
    [binary, ...argv].map(shellQuote).join(" ")
  }`
  const args = Deno.build.os === "linux"
    ? ["-qec", command, "/dev/null"]
    : ["-q", "/dev/null", "sh", "-c", command]
  const signal = AbortSignal.timeout(timeoutMs)
  const child = new Deno.Command("script", {
    args,
    cwd,
    // A pseudo-terminal advertises a real terminal type, whatever the pipes had.
    env: { ...env, TERM: "xterm-256color" },
    clearEnv: true,
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
    signal,
  }).spawn()

  let raw = ""
  const decoder = new TextDecoder()
  const reading = (async () => {
    for await (const chunk of child.stdout) {
      raw += decoder.decode(chunk, { stream: true })
    }
  })()
  const writer = child.stdin.getWriter()
  let problem: string | undefined
  let cursor = 0
  for (const line of script.split("\n")) {
    if (line.trim() === "") continue
    const [verb, ...rest] = line.split(" ")
    const text = rest.join(" ")
    if (verb === "expect") {
      const deadline = Date.now() + EXPECT_TIMEOUT_MS
      let index = -1
      while ((index = cleanTranscript(raw).indexOf(text, cursor)) < 0) {
        if (Date.now() > deadline || signal.aborted) break
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      if (index < 0) {
        problem = `tty: did not see ${JSON.stringify(text)}`
        break
      }
      cursor = index + text.length
      // Let the prompt switch the terminal to raw mode before typing.
      await new Promise((resolve) => setTimeout(resolve, 50))
    } else if (verb === "send") {
      try {
        await writer.write(new TextEncoder().encode(decodeKeys(text)))
        // One key per terminal read, as when a person types.
        await new Promise((resolve) => setTimeout(resolve, 30))
      } catch {
        problem = `tty: the executable exited before ${
          JSON.stringify(text)
        } was sent`
        break
      }
    } else {
      problem = `tty: unknown line ${JSON.stringify(line)}`
      break
    }
  }
  if (problem != null) {
    try {
      child.kill("SIGKILL")
    } catch { /* already exited */ }
  }
  await writer.close().catch(() => {})
  const status = await child.status
  await reading
  return {
    code: status.code,
    stdout: cleanTranscript(raw),
    stderr: "",
    timedOut: signal.aborted,
    problem,
  }
}
