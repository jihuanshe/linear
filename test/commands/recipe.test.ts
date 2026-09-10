import { assertEquals, assertFalse, assertStringIncludes } from "@std/assert"
import { fromFileUrl, join } from "@std/path"
import { recipes } from "../../src/recipes/catalog.ts"

const root = fromFileUrl(new URL("../../", import.meta.url))
const main = join(root, "src/main.ts")
const { denoDir } = JSON.parse(new TextDecoder().decode(
  (await new Deno.Command(Deno.execPath(), {
    args: ["info", "--json"],
    stdout: "piped",
  }).output()).stdout,
)) as { denoDir: string }

async function run(args: string[]) {
  const directory = await Deno.makeTempDir()
  try {
    const result = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--cached-only",
        "--allow-read",
        "--allow-env",
        "--allow-sys",
        "--deny-net",
        "--deny-run",
        "--deny-write",
        "--deny-ffi",
        "--quiet",
        main,
        ...args,
      ],
      cwd: directory,
      clearEnv: true,
      env: {
        HOME: directory,
        XDG_CONFIG_HOME: directory,
        DENO_DIR: denoDir,
        NO_COLOR: "1",
      },
      stdout: "piped",
      stderr: "piped",
    }).output()
    return {
      code: result.code,
      stdout: new TextDecoder().decode(result.stdout),
      stderr: new TextDecoder().decode(result.stderr),
    }
  } finally {
    await Deno.remove(directory, { recursive: true })
  }
}

Deno.test("recipe catalog embeds every instruction and script exactly once", async () => {
  const files = []
  for await (const entry of Deno.readDir(join(root, "recipes"))) {
    if (entry.isFile && entry.name !== "README.md") files.push(entry.name)
  }
  assertEquals(
    files.sort(),
    recipes.flatMap((recipe) => [recipe.filename, `${recipe.name}.md`]).sort(),
  )
  assertEquals(
    new Set(recipes.map((recipe) => recipe.name)).size,
    recipes.length,
  )
  for (const recipe of recipes) {
    assertEquals(
      recipe.body,
      await Deno.readTextFile(join(root, "recipes", `${recipe.name}.md`)),
    )
    assertEquals(
      recipe.source,
      await Deno.readTextFile(join(root, "recipes", recipe.filename)),
    )
    assertStringIncludes(recipe.body, `linear recipe ${recipe.name} --source`)
  }
})

Deno.test("recipe discovery is offline and omits full instructions and source", async () => {
  const result = await run(["recipe", "--json"])
  assertEquals(result.code, 0, result.stderr)
  assertEquals(result.stderr, "")
  const index = JSON.parse(result.stdout)
  assertEquals(index.length, recipes.length)
  for (const item of index) {
    assertEquals(Object.keys(item).sort(), ["description", "name"])
    assertEquals(typeof item.description, "string")
    assertFalse(item.description.length === 0)
  }
  const navigation = await run([])
  assertEquals(navigation.code, 0, navigation.stderr)
  assertStringIncludes(navigation.stdout, "recipe")
})

Deno.test("named recipe JSON returns the installed instructions and exact source", async (t) => {
  for (const recipe of recipes) {
    await t.step(recipe.name, async () => {
      const result = await run(["recipe", recipe.name, "--json"])
      assertEquals(result.code, 0, result.stderr)
      assertEquals(result.stderr, "")
      const document = JSON.parse(result.stdout)
      assertEquals(Object.keys(document).sort(), [
        "body",
        "description",
        "filename",
        "name",
        "source",
      ])
      assertEquals(document.filename, recipe.filename)
      assertEquals(document.body, recipe.body)
      assertEquals(document.source, recipe.source)
    })
  }
})

Deno.test("recipe source exports exact bytes without executing the script", async () => {
  const recipe = recipes.find((item) => item.name === "guarded-edit")!
  const result = await run(["recipe", recipe.name, "--source"])
  assertEquals(result.code, 0, result.stderr)
  assertEquals(result.stderr, "")
  assertEquals(result.stdout, recipe.source)
  const explanation = await run(["recipe", recipe.name])
  assertEquals(explanation.code, 0, explanation.stderr)
  assertEquals(explanation.stdout, recipe.body.trimEnd() + "\n")
})

Deno.test("recipe rejects invalid source requests and unknown names", async () => {
  for (
    const args of [
      ["recipe", "--source", "--json"],
      ["recipe", "doctor", "--source", "--json"],
      ["recipe", "missing", "--json"],
    ]
  ) {
    const result = await run(args)
    assertEquals(result.code, 1, result.stderr)
    const document = JSON.parse(result.stdout)
    assertEquals(document.ok, false)
    assertEquals(document.effect, "none")
    assertEquals(result.stderr, "")
  }
})
