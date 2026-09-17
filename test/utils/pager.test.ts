import { assertEquals } from "@std/assert"
import { join } from "@std/path"
import { getPagerCommand, shouldUsePager } from "../../src/utils/pager.ts"

Deno.test({
  name: "selected pager handles output or returns it directly on failure",
  ignore: Deno.build.os === "windows",
  async fn() {
    const dir = await Deno.makeTempDir()
    const content = "first %c\n第二行  \n"
    const pagerModule =
      new URL("../../src/utils/pager.ts", import.meta.url).href
    try {
      const selected = join(dir, "selected")
      await Deno.writeTextFile(
        selected,
        '#!/bin/sh\nif [ "$1" = ok ]; then printf "paged:\\n"; /bin/cat; else /bin/cat >/dev/null; exit 7; fi\n',
      )
      await Deno.chmod(selected, 0o700)
      for (const name of ["less", "more", "cat"]) {
        const path = join(dir, name)
        await Deno.writeTextFile(
          path,
          '#!/bin/sh\nprintf "alternate pager\\n"\n',
        )
        await Deno.chmod(path, 0o700)
      }
      for (const mode of ["ok", "failed", "missing"]) {
        const result = await new Deno.Command(Deno.execPath(), {
          args: [
            "eval",
            `import { pipeToUserPager } from ${JSON.stringify(pagerModule)};
await pipeToUserPager(${JSON.stringify(content)});`,
          ],
          env: {
            PAGER: mode === "missing"
              ? join(dir, "missing")
              : `${selected} ${mode}`,
            PATH: dir,
          },
          stdout: "piped",
          stderr: "piped",
        }).output()
        assertEquals(result.code, 0)
        assertEquals(new TextDecoder().decode(result.stderr), "")
        assertEquals(
          new TextDecoder().decode(result.stdout),
          mode === "ok" ? `paged:\n${content}` : `${content}\n`,
        )
      }
    } finally {
      await Deno.remove(dir, { recursive: true })
    }
  },
})

Deno.test({
  name: "shouldUsePager - returns false when usePager is false",
  fn() {
    const outputLines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`)
    assertEquals(shouldUsePager(outputLines, false), false)
  },
})

Deno.test({
  name: "shouldUsePager - returns false when not in terminal",
  fn() {
    // Mock stdout.isTerminal to return false
    const originalIsTerminal = Deno.stdout.isTerminal
    Deno.stdout.isTerminal = () => false

    try {
      const outputLines = Array.from(
        { length: 100 },
        (_, i) => `Line ${i + 1}`,
      )
      assertEquals(shouldUsePager(outputLines, true), false)
    } finally {
      Deno.stdout.isTerminal = originalIsTerminal
    }
  },
})

Deno.test({
  name:
    "shouldUsePager - returns true when content is long and conditions are met",
  fn() {
    // Mock stdout.isTerminal to return true
    const originalIsTerminal = Deno.stdout.isTerminal
    Deno.stdout.isTerminal = () => true

    // Mock consoleSize to return a small terminal
    const originalConsoleSize = Deno.consoleSize
    Deno.consoleSize = () => ({ columns: 80, rows: 10 })

    try {
      // Create output longer than terminal height (10 - 2 = 8)
      const outputLines = Array.from({ length: 20 }, (_, i) => `Line ${i + 1}`)
      assertEquals(shouldUsePager(outputLines, true), true)
    } finally {
      Deno.stdout.isTerminal = originalIsTerminal
      Deno.consoleSize = originalConsoleSize
    }
  },
})

Deno.test({
  name: "shouldUsePager - returns false when content is short",
  fn() {
    // Mock stdout.isTerminal to return true
    const originalIsTerminal = Deno.stdout.isTerminal
    Deno.stdout.isTerminal = () => true

    // Mock consoleSize to return a large terminal
    const originalConsoleSize = Deno.consoleSize
    Deno.consoleSize = () => ({ columns: 80, rows: 50 })

    try {
      // Create output shorter than terminal height (50 - 2 = 48)
      const outputLines = Array.from({ length: 10 }, (_, i) => `Line ${i + 1}`)
      assertEquals(shouldUsePager(outputLines, true), false)
    } finally {
      Deno.stdout.isTerminal = originalIsTerminal
      Deno.consoleSize = originalConsoleSize
    }
  },
})

Deno.test({
  name: "getPagerCommand - includes -X flag for less on unix systems",
  fn() {
    // Clear PAGER environment variable to test default behavior
    const originalPager = Deno.env.get("PAGER")
    if (originalPager) Deno.env.delete("PAGER")

    try {
      const pagerConfig = getPagerCommand()
      if (Deno.build.os !== "windows") {
        assertEquals(pagerConfig?.command, "less")
        assertEquals(pagerConfig?.args, ["-R", "-X"])
      }
    } finally {
      // Restore original PAGER if it existed
      if (originalPager) Deno.env.set("PAGER", originalPager)
    }
  },
})
