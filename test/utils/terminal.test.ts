import { assertEquals } from "@std/assert"
import { getColorEnabled, setColorEnabled } from "@std/fmt/colors"
import {
  supportsTerminalStyling,
  withTerminalColors,
} from "../../src/utils/terminal.ts"

const terminal = { isTerminal: () => true }
const pipe = { isTerminal: () => false }

function withTerminalEnv(
  values: Record<string, string | undefined>,
  fn: () => void,
): void {
  const keys = ["NO_COLOR", "TERM", "CLICOLOR"]
  const originals = Object.fromEntries(
    keys.map((key) => [key, Deno.env.get(key)]),
  )
  try {
    for (const key of keys) Deno.env.delete(key)
    for (const [key, value] of Object.entries(values)) {
      if (value != null) Deno.env.set(key, value)
    }
    fn()
  } finally {
    for (const key of keys) {
      const value = originals[key]
      if (value == null) Deno.env.delete(key)
      else Deno.env.set(key, value)
    }
  }
}

for (
  const [name, stream, initial, expected] of [
    ["stdout TTY and stderr pipe", terminal, false, true],
    ["stdout pipe and stderr TTY", pipe, true, false],
  ] as const
) {
  Deno.test(`stream-scoped colors: ${name}`, () => {
    withTerminalEnv({}, () => {
      setColorEnabled(initial)
      assertEquals(
        withTerminalColors(stream, () => getColorEnabled()),
        expected,
      )
      assertEquals(getColorEnabled(), initial)
    })
  })
}

Deno.test("terminal output policy requires a capable TTY", () => {
  withTerminalEnv({}, () => {
    assertEquals(supportsTerminalStyling(terminal), true)
    assertEquals(supportsTerminalStyling(pipe), false)
  })
})

for (
  const [name, env] of [
    ["an empty NO_COLOR", { NO_COLOR: "" }],
    ["TERM=dumb", { TERM: "dumb" }],
    ["CLICOLOR=0", { CLICOLOR: "0" }],
  ] as const
) {
  Deno.test(`terminal output policy rejects ${name}`, () => {
    withTerminalEnv(env, () => {
      assertEquals(supportsTerminalStyling(terminal), false)
    })
  })
}
