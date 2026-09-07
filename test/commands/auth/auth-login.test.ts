import { assertEquals, assertStringIncludes } from "@std/assert"
import { fromFileUrl } from "@std/path"

Deno.test("auth login without key recommends secret prompt or environment, not argv", async () => {
  const root = await Deno.makeTempDir()
  try {
    const result = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-all",
        "--deny-net",
        "--quiet",
        fromFileUrl(new URL("../../../src/main.ts", import.meta.url)),
        "auth",
        "login",
      ],
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
      clearEnv: true,
      env: {
        HOME: root,
        XDG_CONFIG_HOME: root,
        APPDATA: root,
        NO_COLOR: "1",
        LINEAR_PROMPT_DISABLED: "1",
      },
    }).output()
    const stderr = new TextDecoder().decode(result.stderr)
    assertEquals(result.code, 1)
    assertEquals(new TextDecoder().decode(result.stdout), "")
    assertStringIncludes(stderr, "An API key is required")
    assertStringIncludes(stderr, "secret prompt")
    assertStringIncludes(stderr, "secret manager inject LINEAR_API_KEY")
    assertStringIncludes(stderr, "auth login is not required")
    assertEquals(stderr.includes("--key"), false)
    assertEquals(stderr.includes("Requires net access"), false)
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})
