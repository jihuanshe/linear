import { assertEquals, assertStringIncludes } from "@std/assert"
import { fromFileUrl, join } from "@std/path"

const main = fromFileUrl(new URL("../../src/main.ts", import.meta.url))

// Runs without credentials on purpose: every failure asserted here must come
// from local validation, which the command performs for the complete file set
// before its first network request.
async function run(args: string[], cwd?: string) {
  const root = await Deno.makeTempDir()
  try {
    const result = await new Deno.Command(Deno.execPath(), {
      args: ["run", "--allow-all", "--quiet", main, ...args],
      stdout: "piped",
      stderr: "piped",
      clearEnv: true,
      cwd: cwd ?? root,
      env: {
        HOME: root,
        XDG_CONFIG_HOME: root,
        NO_COLOR: "1",
      },
    }).output()
    const decoder = new TextDecoder()
    return {
      code: result.code,
      stdout: decoder.decode(result.stdout),
      stderr: decoder.decode(result.stderr),
    }
  } finally {
    await Deno.remove(root, { recursive: true })
  }
}

Deno.test("upload fails before any network request when a file is missing", async () => {
  const dir = await Deno.makeTempDir()
  try {
    const present = join(dir, "present.png")
    await Deno.writeFile(present, new Uint8Array([1, 2, 3]))

    const result = await run(["upload", present, join(dir, "absent.png")], dir)

    assertEquals(result.code === 0, false)
    assertEquals(result.stdout, "")
    assertStringIncludes(result.stderr, "✗")
    assertStringIncludes(result.stderr, "absent.png")
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test("upload --public rejects non-image types with guidance", async () => {
  const dir = await Deno.makeTempDir()
  try {
    const pdf = join(dir, "evidence.pdf")
    await Deno.writeFile(pdf, new Uint8Array([1]))

    const result = await run(["upload", "--public", pdf], dir)

    assertEquals(result.code === 0, false)
    assertEquals(result.stdout, "")
    assertStringIncludes(result.stderr, "public")
    assertStringIncludes(result.stderr, "Remove --public")
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test("upload --help documents the primitive", async () => {
  const result = await run(["upload", "--help"])

  assertEquals(result.code, 0, result.stderr)
  assertStringIncludes(result.stdout, "asset URL")
  assertStringIncludes(result.stdout, "Writes: true")
})
