import { assertEquals, assertStringIncludes } from "@std/assert"
import { fromFileUrl, join } from "@std/path"

Deno.test("config wizard refuses every selected existing project file before prompting or network", async () => {
  const root = await Deno.makeTempDir()
  const cache = await new Deno.Command(Deno.execPath(), {
    args: ["info", "--json"],
    stdout: "piped",
    stderr: "piped",
  }).output()
  const denoDir = JSON.parse(new TextDecoder().decode(cache.stdout)).denoDir
  try {
    const git = await new Deno.Command("git", {
      args: ["init", "--quiet", root],
    }).output()
    assertEquals(git.success, true)
    await Deno.mkdir(join(root, "sub"))
    await Deno.mkdir(join(root, ".config"))
    for (
      const relative of [
        "sub/.linear.toml",
        ".linear.toml",
        ".config/linear.toml",
      ]
    ) {
      const path = join(root, relative)
      const original = '# user-owned configuration\nworkspace = "existing"\n'
      await Deno.writeTextFile(path, original)
      const result = await new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "--allow-all",
          "--deny-net",
          "--quiet",
          `--config=${
            fromFileUrl(new URL("../../deno.json", import.meta.url))
          }`,
          new URL("../../src/main.ts", import.meta.url).href,
          "config",
        ],
        cwd: join(root, "sub"),
        clearEnv: true,
        env: {
          HOME: root,
          XDG_CONFIG_HOME: join(root, "global"),
          APPDATA: join(root, "global"),
          DENO_DIR: denoDir,
          PATH: Deno.env.get("PATH") ?? "",
          SystemRoot: Deno.env.get("SystemRoot") ?? "",
          NO_COLOR: "1",
        },
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      }).output()
      assertEquals(result.success, false)
      assertEquals(new TextDecoder().decode(result.stdout), "")
      assertStringIncludes(
        new TextDecoder().decode(result.stderr),
        `Configuration already exists at ${path}`,
      )
      assertEquals(await Deno.readTextFile(path), original)
      await Deno.remove(path)
    }
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})
