import { assertEquals, assertRejects } from "@std/assert"
import { join } from "@std/path"
import { openEditor } from "../../src/utils/editor.ts"
import { CliError, ValidationError } from "../../src/utils/errors.ts"

Deno.test({
  name:
    "editor preserves exact UTF-8 and fails closed on missing editor, process and read errors",
  ignore: Deno.build.os === "windows",
  async fn() {
    const dir = await Deno.makeTempDir()
    const previous = new Map(
      ["GIT_CONFIG_GLOBAL", "EDITOR"].map((key) => [key, Deno.env.get(key)]),
    )
    const config = join(dir, "gitconfig")
    const editor = join(dir, "editor")
    const recorded = join(dir, "path")
    const source = "\uFEFF  indented\r\nline  \r\n\\n\r\n\r\n"
    try {
      await Deno.writeTextFile(config, "")
      Deno.env.set("GIT_CONFIG_GLOBAL", config)
      Deno.env.delete("EDITOR")
      await assertRejects(
        () => openEditor(),
        ValidationError,
        "No editor found",
      )
      Deno.env.set("EDITOR", editor)
      await assertRejects(
        () => openEditor(source),
        CliError,
        "Failed to open editor",
      )
      for (const text of [source, "", " \r\n"]) {
        await Deno.writeTextFile(
          editor,
          `#!/bin/sh\nprintf '%s' "$1" > '${recorded}'\n`,
        )
        await Deno.chmod(editor, 0o700)
        assertEquals(await openEditor(text), text)
        const path = await Deno.readTextFile(recorded)
        await assertRejects(() => Deno.stat(path), Deno.errors.NotFound)
      }
      for (const script of ["exit 7", 'rm "$1"', 'printf "\\377" > "$1"']) {
        await Deno.writeTextFile(editor, `#!/bin/sh\n${script}\n`)
        await assertRejects(() => openEditor(source), CliError)
      }
    } finally {
      for (const [key, value] of previous) {
        if (value == null) Deno.env.delete(key)
        else Deno.env.set(key, value)
      }
      await Deno.remove(dir, { recursive: true })
    }
  },
})
