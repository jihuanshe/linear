import { assertEquals } from "@std/assert"
import { fromFileUrl, join } from "@std/path"

const graphqlUrl = new URL("../../src/utils/graphql.ts", import.meta.url)
const configUrl = new URL("../../src/config.ts", import.meta.url)
const keyringUrl = new URL("../../src/keyring/index.ts", import.meta.url)
const errorsUrl = new URL("../../src/utils/errors.ts", import.meta.url)
const denoConfig = fromFileUrl(new URL("../../deno.json", import.meta.url))
const cache = await new Deno.Command(Deno.execPath(), {
  args: ["info", "--json"],
  stdout: "piped",
  stderr: "piped",
}).output()
const denoDir = JSON.parse(new TextDecoder().decode(cache.stdout)).denoDir

async function probe(root: string, code: string) {
  const result = await new Deno.Command(Deno.execPath(), {
    args: ["eval", `--config=${denoConfig}`, code],
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
  assertEquals(result.success, true, new TextDecoder().decode(result.stderr))
}

Deno.test("selected keyring lookup is lazy, shared by concurrent requests, and pinned through writes", async () => {
  const root = await Deno.makeTempDir()
  try {
    await Deno.mkdir(join(root, "linear"))
    await Deno.writeTextFile(
      join(root, "linear", "credentials.toml"),
      'default = "default"\nworkspaces = ["default", "selected", "broken"]\n',
    )
    await Deno.writeTextFile(
      join(root, ".linear.toml"),
      'workspace = "broken"\n',
    )
    await probe(
      root,
      `
      import { assertEquals } from "@std/assert";
      import { _setBackend } from ${JSON.stringify(keyringUrl.href)};
      import { setCliWorkspace } from ${JSON.stringify(configUrl.href)};
      import { getGraphQLClient, getResolvedApiKey, withGraphQLContext } from ${
        JSON.stringify(graphqlUrl.href)
      };
      const reads = [];
      _setBackend({
        async get(ws) { reads.push(ws); if (ws === "broken") throw new Error("locked"); await Promise.resolve(); return ws + "-key" },
        async set() { throw new Error("unexpected write") }, async delete() {}, async isAvailable() { throw new Error("unexpected probe") }
      });
      const headers = [];
      globalThis.fetch = async (_input, init) => {
        headers.push(new Headers(init.headers).get("authorization"));
        return Response.json({data: {result: {success: true}}});
      };
      Deno.env.set("LINEAR_WORKSPACE", "default");
      setCliWorkspace("selected");
      await withGraphQLContext(async () => {
        const client = getGraphQLClient();
        assertEquals(reads, []);
        await Promise.all([client.request("query Verify { organization { id } }"), client.request("query Prepare { viewer { id } }")]);
        setCliWorkspace("broken");
        Deno.env.set("LINEAR_API_KEY", "replacement");
        assertEquals(await getResolvedApiKey(), "selected-key");
        await getGraphQLClient().request("mutation Write { issueUpdate { success } }");
      });
      assertEquals(reads, ["selected"]);
      assertEquals(headers, ["selected-key", "selected-key", "selected-key"]);
      Deno.env.delete("LINEAR_API_KEY");
      setCliWorkspace(undefined);
      await withGraphQLContext(async () => { assertEquals(await getResolvedApiKey(), "default-key") });
      assertEquals(reads, ["selected", "default"]);
    `,
    )
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test("selected unavailable keyring fails before transport; unrelated default is never attempted", async () => {
  const root = await Deno.makeTempDir()
  try {
    await Deno.mkdir(join(root, "linear"))
    await Deno.writeTextFile(
      join(root, "linear", "credentials.toml"),
      'default = "healthy"\nworkspaces = ["healthy", "locked"]\n',
    )
    await probe(
      root,
      `
      import { assertEquals, assertRejects } from "@std/assert";
      import { _setBackend } from ${JSON.stringify(keyringUrl.href)};
      import { setCliWorkspace } from ${JSON.stringify(configUrl.href)};
      import { getGraphQLClient, withGraphQLContext } from ${
        JSON.stringify(graphqlUrl.href)
      };
      import { errorResult, AuthError } from ${JSON.stringify(errorsUrl.href)};
      const reads = [];
      _setBackend({ async get(ws) { reads.push(ws); throw new Error("DO_NOT_ECHO") }, async set() {}, async delete() {}, async isAvailable() { return false } });
      let dispatched = 0;
      globalThis.fetch = async () => { dispatched++; throw new Error("must not send") };
      setCliWorkspace("locked");
      await withGraphQLContext(async () => {
        const failure = await assertRejects(() => getGraphQLClient().request("mutation Write { issueUpdate { success } }"), AuthError);
        assertEquals(errorResult(failure).effect, "none");
        assertEquals(failure.message.includes("DO_NOT_ECHO"), false);
      });
      assertEquals(reads, ["locked"]);
      assertEquals(dispatched, 0);
    `,
    )
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test("environment, explicit-key and public clients do not read unrelated credential inventory", async () => {
  const root = await Deno.makeTempDir()
  try {
    await Deno.mkdir(join(root, "linear"))
    await Deno.writeTextFile(
      join(root, "linear", "credentials.toml"),
      'broken = ["DO_NOT_ECHO\n',
    )
    await probe(
      root,
      `
      import { assertEquals } from "@std/assert";
      import { getGraphQLClient, createGraphQLClient, createPublicGraphQLClient } from ${
        JSON.stringify(graphqlUrl.href)
      };
      const authorizations = [];
      globalThis.fetch = async (_input, init) => {
        authorizations.push(new Headers(init.headers).get("authorization"));
        return Response.json({data: {viewer: {id: "test"}}});
      };
      Deno.env.set("LINEAR_API_KEY", "environment-key");
      await getGraphQLClient().request("query Read { viewer { id } }");
      Deno.writeTextFileSync(".linear.toml", 'api_key = "obsolete"');
      await createGraphQLClient("login-key").request("query Read { viewer { id } }");
      await createPublicGraphQLClient().request("query Public { viewer { id } }");
      assertEquals(authorizations, ["environment-key", "login-key", null]);
    `,
    )
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})
