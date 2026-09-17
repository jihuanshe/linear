import { assertEquals, assertStringIncludes } from "@std/assert"
import { fromFileUrl } from "@std/path"

// Isolate the local credential inventory and fake keyring.

const credentialsUrl = new URL("../../../src/credentials.ts", import.meta.url)
const commandUrl = new URL(
  "../../../src/commands/auth/auth-migrate.ts",
  import.meta.url,
)
const keyringUrl = new URL("../../../src/keyring/index.ts", import.meta.url)
const denoJsonPath = fromFileUrl(new URL("../../../deno.json", import.meta.url))
const denoDir = Deno.env.get("DENO_DIR") ??
  (Deno.build.os === "darwin"
    ? `${Deno.env.get("HOME")}/Library/Caches/deno`
    : `${Deno.env.get("HOME")}/.cache/deno`)

async function runSubprocess(
  tempDir: string,
  code: string,
): Promise<{ stdout: string; stderr: string; success: boolean }> {
  const isWindows = Deno.build.os === "windows"
  const env: Record<string, string> = isWindows
    ? { APPDATA: tempDir, SystemRoot: Deno.env.get("SystemRoot") ?? "" }
    : {
      HOME: tempDir,
      XDG_CONFIG_HOME: tempDir,
      DENO_DIR: denoDir,
      PATH: Deno.env.get("PATH") ?? "",
      NO_COLOR: "1",
    }

  const command = new Deno.Command("deno", {
    args: ["eval", `--config=${denoJsonPath}`, code],
    cwd: tempDir,
    env,
    stdout: "piped",
    stderr: "piped",
  })

  const result = await command.output()
  return {
    stdout: new TextDecoder().decode(result.stdout).trim(),
    stderr: new TextDecoder().decode(result.stderr),
    success: result.success,
  }
}

Deno.test("auth migrate - already using keyring format prints message", async () => {
  const tempDir = await Deno.makeTempDir()

  try {
    const configDir = `${tempDir}/linear`
    await Deno.mkdir(configDir, { recursive: true })
    await Deno.writeTextFile(
      `${configDir}/credentials.toml`,
      `default = "my-ws"\nworkspaces = ["my-ws"]\n`,
    )

    const code = `
import { _setBackend } from "${keyringUrl}";
_setBackend({
  async get(_account: string) { return "lin_api_key" },
  async set(_a: string, _p: string) {},
  async delete(_a: string) {},
  async isAvailable() { return true },
});
const { migrateCommand } = await import("${commandUrl}");
await migrateCommand.parse([]);
`

    const { stdout, success } = await runSubprocess(tempDir, code)
    assertEquals(success, true)
    assertEquals(stdout, "Credentials are already using the system keyring.")
  } finally {
    await Deno.remove(tempDir, { recursive: true })
  }
})

Deno.test("auth migrate - no keyring available throws error", async () => {
  const tempDir = await Deno.makeTempDir()

  try {
    const configDir = `${tempDir}/linear`
    await Deno.mkdir(configDir, { recursive: true })
    await Deno.writeTextFile(
      `${configDir}/credentials.toml`,
      `default = "my-ws"\nmy-ws = "lin_api_key"\n`,
    )

    const code = `
import { _setBackend } from "${keyringUrl}";
_setBackend({
  async get(_account: string) { return null },
  async set(_a: string, _p: string) {},
  async delete(_a: string) {},
  async isAvailable() { return false },
});
const { migrateCommand } = await import("${commandUrl}");
await migrateCommand.parse([]);
`

    const { stderr, success } = await runSubprocess(tempDir, code)
    assertEquals(success, false)
    assertStringIncludes(
      stderr,
      "No system keyring found. Cannot migrate credentials.",
    )
  } finally {
    await Deno.remove(tempDir, { recursive: true })
  }
})

Deno.test("auth migrate - happy path migrates inline credentials to keyring", async () => {
  const tempDir = await Deno.makeTempDir()

  try {
    const configDir = `${tempDir}/linear`
    await Deno.mkdir(configDir, { recursive: true })
    await Deno.writeTextFile(
      `${configDir}/credentials.toml`,
      `default = "ws-a"\nws-a = "lin_api_a"\nws-b = "lin_api_b"\n`,
    )

    const code = `
import { _setBackend } from "${keyringUrl}";
const _store = new Map<string, string>();
_setBackend({
  async get(account: string) { return _store.get(account) ?? null },
  async set(account: string, password: string) { _store.set(account, password) },
  async delete(account: string) { _store.delete(account) },
  async isAvailable() { return true },
});
const { isUsingInlineFormat, getCredentialApiKey } = await import("${credentialsUrl}");
const { migrateCommand } = await import("${commandUrl}");
await migrateCommand.parse([]);
console.log(JSON.stringify({
  migrated: [..._store.keys()].sort(),
  isInlineAfter: isUsingInlineFormat(),
  keyA: await getCredentialApiKey("ws-a"),
  keyB: await getCredentialApiKey("ws-b"),
}));
`

    const { stdout, success } = await runSubprocess(tempDir, code)
    assertEquals(success, true)
    const result = JSON.parse(stdout.split("\n").at(-1)!)
    assertEquals(result.migrated, ["ws-a", "ws-b"])
    assertEquals(result.isInlineAfter, false)
    assertEquals(result.keyA, "lin_api_a")
    assertEquals(result.keyB, "lin_api_b")
  } finally {
    await Deno.remove(tempDir, { recursive: true })
  }
})
