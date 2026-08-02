import { getColorEnabled, setColorEnabled } from "@std/fmt/colors"

export interface TerminalStream {
  isTerminal(): boolean
}

/** Whether a stream supports styled terminal output. */
export function supportsTerminalStyling(stream: TerminalStream): boolean {
  return stream.isTerminal() &&
    Deno.env.get("NO_COLOR") == null &&
    Deno.env.get("TERM") !== "dumb" &&
    Deno.env.get("CLICOLOR") !== "0"
}

export function supportsStdoutStyling(): boolean {
  return supportsTerminalStyling(Deno.stdout)
}

/** Run synchronously with @std colors configured for the given stream. */
export function withTerminalColors<T>(stream: TerminalStream, fn: () => T): T {
  const previous = getColorEnabled()
  setColorEnabled(supportsTerminalStyling(stream))
  try {
    return fn()
  } finally {
    setColorEnabled(previous)
  }
}

/** Initialize @std/fmt/colors before Cliffy parses and renders output. */
export function initializeStdoutColors(): void {
  setColorEnabled(supportsStdoutStyling())
}
