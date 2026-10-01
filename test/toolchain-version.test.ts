import { assert, assertEquals, assertStringIncludes } from "@std/assert"

// mise.toml is the canonical home of the Deno toolchain version. These files
// repeat it for documentation and release builds and must follow a bump
// together; this test keeps the mirrors from drifting.
const MIRRORS = [
  "AGENTS.md",
  ".github/workflows/ship-main.yml",
]

Deno.test("toolchain version mirrors follow mise.toml", async () => {
  const mise = await Deno.readTextFile("mise.toml")
  const match = mise.match(/deno = "([^"]+)"/)
  if (match == null) throw new Error("mise.toml lacks a pinned deno version")
  for (const file of MIRRORS) {
    assertStringIncludes(
      await Deno.readTextFile(file),
      match[1],
      `${file} must pin Deno ${match[1]} (canonical home: mise.toml)`,
    )
  }
})

Deno.test("mise native lock sidecars are tracked", async () => {
  const decoder = new TextDecoder()
  const result = await new Deno.Command("mise", {
    args: ["lock", "--sidecars", "--json"],
  }).output()
  assertEquals(result.code, 0, decoder.decode(result.stderr))
  const inventory: {
    lockfile: string
    sidecars: { path: string; exists: boolean }[]
  }[] = JSON.parse(decoder.decode(result.stdout))
  const lock = inventory.find(({ lockfile }) => lockfile === "mise.lock")
  assert(lock, "mise.lock is missing from the native lock inventory")

  // Locked installation validates the graph; this source gate checks that
  // its assets will also exist in a fresh checkout, including ignored files.
  for (const { path, exists } of lock.sidecars) {
    assert(exists, `Missing native lock sidecar: ${path}`)
    const tracked = await new Deno.Command("git", {
      args: ["ls-files", "--error-unmatch", "--", path],
    }).output()
    assertEquals(tracked.code, 0, decoder.decode(tracked.stderr))
    const missing = await new Deno.Command("git", {
      args: ["ls-files", "--others", "--deleted", "--", path],
    }).output()
    assertEquals(
      decoder.decode(missing.stdout),
      "",
      `Native lock assets must be present and tracked: ${path}`,
    )
    assertEquals(missing.code, 0, decoder.decode(missing.stderr))
  }
})
