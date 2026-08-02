import { renderMarkdown as renderCharmd } from "@littletof/charmd"
import { stripAnsiCode } from "@std/fmt/colors"
import { supportsStdoutStyling } from "./terminal.ts"

type RenderOptions = Parameters<typeof renderCharmd>[1]

/** Strip OSC wrappers before CSI codes, preserving OSC-8 display text. */
export function stripTerminalSequences(text: string): string {
  // deno-lint-ignore no-control-regex -- terminal escapes are the intended input.
  const oscSequence = new RegExp(
    "\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)",
    "g",
  )
  const withoutOsc = text.replace(oscSequence, "")
  return stripAnsiCode(withoutOsc)
}

export function renderMarkdown(
  markdown: string,
  options?: RenderOptions,
): string {
  const rendered = renderCharmd(markdown, options)
  return supportsStdoutStyling() ? rendered : stripTerminalSequences(rendered)
}
