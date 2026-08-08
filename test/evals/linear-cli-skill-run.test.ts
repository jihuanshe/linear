import { assertEquals, assertThrows } from "@std/assert"
import { join } from "@std/path"
import { parseSkillDirs } from "../../evals/linear-cli-skill/run.ts"

Deno.test("parseSkillDirs accepts the legacy singular argument and multiple Skills", () => {
  const root = Deno.makeTempDirSync()
  const linear = join(root, "linear")
  const access = join(root, "linear-access")
  Deno.mkdirSync(linear)
  Deno.mkdirSync(access)
  try {
    assertEquals(parseSkillDirs(linear, undefined), [linear])
    assertEquals(parseSkillDirs(undefined, `${linear}, ${access}`), [
      linear,
      access,
    ])
  } finally {
    Deno.removeSync(root, { recursive: true })
  }
})

Deno.test("parseSkillDirs rejects ambiguous or empty inputs", () => {
  assertThrows(
    () => parseSkillDirs("one", "two"),
    Error,
    "either --skill-dir or --skill-dirs",
  )
  assertThrows(
    () => parseSkillDirs(undefined, ", ,"),
    Error,
    "at least one skill directory",
  )
})

Deno.test("parseSkillDirs rejects duplicate installation names", () => {
  const root = Deno.makeTempDirSync()
  const first = join(root, "first", "linear")
  const second = join(root, "second", "linear")
  Deno.mkdirSync(first, { recursive: true })
  Deno.mkdirSync(second, { recursive: true })
  try {
    assertThrows(
      () => parseSkillDirs(undefined, `${first},${second}`),
      Error,
      "unique base names",
    )
  } finally {
    Deno.removeSync(root, { recursive: true })
  }
})
