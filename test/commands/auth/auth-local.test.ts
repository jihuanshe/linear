import { assertEquals, assertStringIncludes } from "@std/assert"
import { fromFileUrl, join } from "@std/path"

const keyringUrl = new URL("../../../src/keyring/index.ts", import.meta.url)
const cliUrl = new URL("../../../src/cli.ts", import.meta.url)
const credentialsUrl = new URL("../../../src/credentials.ts", import.meta.url)
const configPath = fromFileUrl(new URL("../../../deno.json", import.meta.url))
const cache = await new Deno.Command(Deno.execPath(), {
  args: ["info", "--json"],
  stdout: "piped",
  stderr: "piped",
}).output()
const denoDir = JSON.parse(new TextDecoder().decode(cache.stdout)).denoDir

async function run(root: string, code: string) {
  const result = await new Deno.Command(Deno.execPath(), {
    args: ["eval", `--config=${configPath}`, code],
    cwd: root,
    clearEnv: true,
    env: {
      HOME: root,
      XDG_CONFIG_HOME: root,
      APPDATA: root,
      DENO_DIR: denoDir,
      PATH: Deno.env.get("PATH") ?? "",
      SystemRoot: Deno.env.get("SystemRoot") ?? "",
      NO_COLOR: "1",
    },
    stdout: "piped",
    stderr: "piped",
  }).output()
  return {
    success: result.success,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  }
}

Deno.test("auth list is local inventory despite malformed project config and unavailable keyring", async () => {
  const root = await Deno.makeTempDir()
  try {
    await Deno.mkdir(join(root, "linear"))
    await Deno.writeTextFile(
      join(root, "linear", "credentials.toml"),
      'default = "first"\nworkspaces = ["first", "locked"]',
    )
    await Deno.writeTextFile(join(root, ".linear.toml"), "invalid = [")
    const result = await run(
      root,
      `
      const fail = () => { throw new Error("must stay local") };
      globalThis.fetch = fail;
      const { _setBackend } = await import(${JSON.stringify(keyringUrl.href)});
      _setBackend({ get: fail, set: fail, delete: fail, isAvailable: fail });
      const { cli } = await import(${JSON.stringify(cliUrl.href)});
      await cli.parse(["auth", "list"]);
    `,
    )
    assertEquals(result.success, true, result.stderr)
    assertEquals(result.stderr, "")
    assertStringIncludes(result.stdout, "credentials not validated")
    assertStringIncludes(result.stdout, "* first")
    assertStringIncludes(result.stdout, "  locked")
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test("auth default rejects a wrong explicit target even with one workspace", async () => {
  const root = await Deno.makeTempDir()
  try {
    await Deno.mkdir(join(root, "linear"))
    const path = join(root, "linear", "credentials.toml")
    const original = 'default = "only"\nworkspaces = ["only"]'
    await Deno.writeTextFile(path, original)
    const result = await run(
      root,
      `
      const { cli } = await import(${JSON.stringify(cliUrl.href)});
      await cli.parse(["auth", "default", "wrong"]);
    `,
    )
    assertEquals(result.success, false)
    assertStringIncludes(result.stderr, "Workspace not found: wrong")
    assertEquals(await Deno.readTextFile(path), original)
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test("auth login changes only its validated workspace and never offers global migration", async () => {
  const root = await Deno.makeTempDir()
  try {
    await Deno.mkdir(join(root, "linear"))
    await Deno.writeTextFile(
      join(root, "linear", "credentials.toml"),
      'default = "other"\nother = "synthetic-other-key"\n',
    )
    const result = await run(
      root,
      `
      import { assertEquals } from "@std/assert";
      const fail = () => { throw new Error("must not probe or migrate keyring") };
      const { _setBackend } = await import(${JSON.stringify(keyringUrl.href)});
      _setBackend({ get: fail, set: fail, delete: fail, isAvailable: fail });
      const headers = [];
      globalThis.fetch = async (_input, init) => {
        headers.push(new Headers(init.headers).get("authorization"));
        return Response.json({data: {viewer: {name: "Test", email: "test@example.com", organization: {name: "Selected", urlKey: "selected"}}}});
      };
      const { cli } = await import(${JSON.stringify(cliUrl.href)});
      await cli.parse(["auth", "login", "--key", "synthetic_new_key"]);
      const { getCredentialApiKey, getDefaultWorkspace, isUsingInlineFormat } = await import(${
        JSON.stringify(credentialsUrl.href)
      });
      assertEquals(headers, ["synthetic_new_key"]);
      assertEquals(getDefaultWorkspace(), "other");
      assertEquals(await getCredentialApiKey("other"), "synthetic-other-key");
      assertEquals(await getCredentialApiKey("selected"), "synthetic_new_key");
      assertEquals(isUsingInlineFormat(), true);
    `,
    )
    assertEquals(result.success, true, result.stderr)
    assertEquals(result.stdout.includes("Migrate all"), false)
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})
