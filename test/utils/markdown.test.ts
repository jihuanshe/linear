import { assertEquals } from "@std/assert"
import { stripTerminalSequences } from "../../src/utils/markdown.ts"

Deno.test("stripTerminalSequences preserves CSI and OSC-8 display text", () => {
  const red = "\x1b[31mred\x1b[0m"
  const link = "\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\"
  assertEquals(stripTerminalSequences(red), "red")
  assertEquals(stripTerminalSequences(link), "link")
  assertEquals(stripTerminalSequences(`${red} ${link}`), "red link")
})
