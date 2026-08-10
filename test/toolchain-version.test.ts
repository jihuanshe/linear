import { assertStringIncludes } from "@std/assert"

// mise.toml is the canonical home of the Deno toolchain version. These files
// repeat it for bootstrap and CI and must follow a bump together; this test is
// the gate that keeps the mirrors from drifting.
const MIRRORS = [
  ".agents/setup",
  ".agents/resume",
  "AGENTS.md",
  ".github/workflows/ship-main.yml",
  ".github/workflows/verify-pull-request.yml",
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
