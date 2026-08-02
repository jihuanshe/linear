import { assertEquals, assertMatch } from "@std/assert"
import { fromFileUrl, join } from "@std/path"

const main = fromFileUrl(new URL("../src/main.ts", import.meta.url))

async function run(args: string[], env: Record<string, string> = {}) {
  const result = await new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-all", "--quiet", main, ...args],
    stdout: "piped",
    stderr: "piped",
    clearEnv: true,
    env: {
      HOME: Deno.env.get("HOME") ?? "",
      PATH: Deno.env.get("PATH") ?? "",
      TERM: "xterm-256color",
      ...env,
    },
  }).output()
  const decoder = new TextDecoder()
  return {
    code: result.code,
    stdout: decoder.decode(result.stdout),
    stderr: decoder.decode(result.stderr),
  }
}

Deno.test("main writes explicit help to stdout with rc 0", async () => {
  const result = await run(["--help"])
  assertEquals(result.code, 0)
  assertMatch(result.stdout, /Usage:\s+linear/)
  assertEquals(result.stderr, "")
})

Deno.test("startup credentials warning honors disabled color policy", async () => {
  const root = await Deno.makeTempDir()
  try {
    const config = join(root, "linear")
    await Deno.mkdir(config, { recursive: true })
    await Deno.writeTextFile(
      join(config, "credentials.toml"),
      'default = "missing"\nworkspaces = ["present"]\n',
    )
    const result = await run(["--help"], {
      HOME: join(root, "home"),
      XDG_CONFIG_HOME: root,
      NO_COLOR: "",
    })
    assertMatch(result.stderr, /Default workspace "missing"/)
    assertEquals(result.stderr.includes("\x1b"), false)
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

for (
  const [name, args] of [
    ["unknown flag", ["--not-a-real-flag"]],
    ["unknown command", ["not-a-real-command"]],
  ] as const
) {
  Deno.test(`main sends ${name} usage errors only to stderr`, async () => {
    const result = await run([...args])
    assertEquals(result.code, 2)
    assertEquals(result.stdout, "")
    assertMatch(result.stderr, /Unknown (option|command)/)
  })
}

for (
  const [name, env] of [
    ["NO_COLOR", { NO_COLOR: "" }],
    ["TERM=dumb", { TERM: "dumb" }],
    ["CLICOLOR=0", { CLICOLOR: "0" }],
  ] as const
) {
  Deno.test(`non-TTY main help has no terminal escapes with ${name}`, async () => {
    const result = await run(["--help"], env)
    assertEquals(result.code, 0)
    assertEquals((result.stdout + result.stderr).includes("\x1b"), false)
  })
}
