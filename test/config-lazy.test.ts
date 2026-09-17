import { assertEquals, assertStringIncludes } from "@std/assert"
import { fromFileUrl, join } from "@std/path"

const configUrl = new URL("../src/config.ts", import.meta.url)
const cliUrl = new URL("../src/cli.ts", import.meta.url)
const mainUrl = new URL("../src/main.ts", import.meta.url)
const denoConfig = fromFileUrl(new URL("../deno.json", import.meta.url))
const cache = await new Deno.Command(Deno.execPath(), {
  args: ["info", "--json"],
  stdout: "piped",
  stderr: "piped",
}).output()
const denoDir = JSON.parse(new TextDecoder().decode(cache.stdout)).denoDir

function run(root: string, args: string[], env: Record<string, string> = {}) {
  return new Deno.Command(Deno.execPath(), {
    args,
    cwd: root,
    clearEnv: true,
    env: {
      DENO_DIR: denoDir,
      HOME: root,
      XDG_CONFIG_HOME: join(root, "global"),
      APPDATA: join(root, "global"),
      PATH: Deno.env.get("PATH") ?? "",
      SystemRoot: Deno.env.get("SystemRoot") ?? "",
      NO_COLOR: "1",
      LINEAR_PROMPT_DISABLED: "1",
      ...env,
    },
    stdout: "piped",
    stderr: "piped",
  }).output()
}

function evaluate(root: string, code: string, env?: Record<string, string>) {
  return run(root, ["eval", `--config=${denoConfig}`, code], env)
}

Deno.test("config/auth/CLI imports perform no configuration, dotenv or keyring I/O", async () => {
  const root = await Deno.makeTempDir()
  try {
    const result = await evaluate(
      root,
      `
      const fail = () => { throw new Error("unexpected I/O") };
      Deno.readTextFile = fail;
      Deno.readTextFileSync = fail;
      Deno.statSync = fail;
      const { _setBackend } = await import(${
        JSON.stringify(new URL("../src/keyring/index.ts", import.meta.url).href)
      });
      _setBackend({ get: fail, set: fail, delete: fail, isAvailable: fail });
      await import(${JSON.stringify(cliUrl.href)});
      console.log("imported without I/O");
    `,
    )
    assertEquals(result.success, true, new TextDecoder().decode(result.stderr))
    assertEquals(
      new TextDecoder().decode(result.stdout).trim(),
      "imported without I/O",
    )
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test("offline discovery ignores malformed configs, credentials and unavailable dotenv", async () => {
  const root = await Deno.makeTempDir()
  try {
    await Deno.mkdir(join(root, "global", "linear"), { recursive: true })
    await Deno.mkdir(join(root, ".env"))
    for (
      const path of [
        ".linear.toml",
        "linear.toml",
        "global/linear/linear.toml",
        "global/linear/credentials.toml",
      ]
    ) {
      await Deno.writeTextFile(join(root, path), 'api_key = "DO_NOT_ECHO\n')
    }
    for (
      const args of [
        [],
        ["--help"],
        ["--version"],
        ["version", "--json"],
        ["issue"],
        ["auth"],
        ["issue", "query", "--help"],
        ["usage", "--json"],
        ["guide", "issue-delivery"],
        ["recipe", "--json"],
        ["completions", "bash"],
      ]
    ) {
      const result = await run(root, [
        "run",
        "--allow-all",
        "--deny-net",
        "--quiet",
        `--config=${denoConfig}`,
        mainUrl.href,
        ...args,
      ])
      const stderr = new TextDecoder().decode(result.stderr)
      assertEquals(result.success, true, `${args.join(" ")}: ${stderr}`)
      assertEquals(stderr, "")
      assertEquals(
        new TextDecoder().decode(result.stdout).includes("DO_NOT_ECHO"),
        false,
      )
    }
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test("dotenv preserves inherited LINEAR/GH/GITHUB and cwd precedence over git root", async () => {
  const root = await Deno.makeTempDir()
  try {
    const initialized = await new Deno.Command("git", {
      args: ["init", "--quiet", root],
    }).output()
    assertEquals(initialized.success, true)
    await Deno.mkdir(join(root, "sub"))
    await Deno.writeTextFile(
      join(root, ".env"),
      "LINEAR_WORKSPACE=root\nGH_TOKEN=root-gh\nGITHUB_TOKEN=root-github\n",
    )
    await Deno.writeTextFile(
      join(root, "sub", ".env"),
      "LINEAR_WORKSPACE=cwd\nGH_TOKEN=cwd-gh\nGITHUB_TOKEN=cwd-github\nOTHER_SECRET=ignored\n",
    )
    const code = `
      import { loadEnvironment } from ${JSON.stringify(configUrl.href)};
      loadEnvironment();
      console.log(JSON.stringify([Deno.env.get("LINEAR_WORKSPACE"), Deno.env.get("GH_TOKEN"), Deno.env.get("GITHUB_TOKEN"), Deno.env.get("OTHER_SECRET")]));
    `
    const inherited = await evaluate(join(root, "sub"), code, {
      LINEAR_WORKSPACE: "inherited",
      GH_TOKEN: "inherited-gh",
      GITHUB_TOKEN: "inherited-github",
    })
    assertEquals(inherited.success, true)
    assertEquals(JSON.parse(new TextDecoder().decode(inherited.stdout)), [
      "inherited",
      "inherited-gh",
      "inherited-github",
      null,
    ])
    const cwd = await evaluate(join(root, "sub"), code)
    assertEquals(cwd.success, true)
    assertEquals(JSON.parse(new TextDecoder().decode(cwd.stdout)), [
      "cwd",
      "cwd-gh",
      "cwd-github",
      null,
    ])
    await Deno.remove(join(root, "sub", ".env"))
    const fallback = await evaluate(join(root, "sub"), code)
    assertEquals(fallback.success, true)
    assertEquals(JSON.parse(new TextDecoder().decode(fallback.stdout)), [
      "root",
      "root-gh",
      "root-github",
      null,
    ])
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test("update action receives dotenv without parsing unrelated configuration", async () => {
  const root = await Deno.makeTempDir()
  try {
    await Deno.writeTextFile(
      join(root, ".env"),
      "GH_TOKEN=fixture-gh\nGITHUB_TOKEN=fixture-github\n",
    )
    await Deno.writeTextFile(
      join(root, ".linear.toml"),
      'workspace = "unterminated',
    )
    const result = await evaluate(
      root,
      `
      import { cli } from ${JSON.stringify(cliUrl.href)};
      Deno.exit = () => { throw new Error("exit") };
      try { await cli.parse(["update"]) } catch (error) {
        if (error.message !== "exit") throw error;
      }
      console.log(JSON.stringify([Deno.env.get("GH_TOKEN"), Deno.env.get("GITHUB_TOKEN")]));
    `,
    )
    assertEquals(result.success, true, new TextDecoder().decode(result.stderr))
    assertEquals(JSON.parse(new TextDecoder().decode(result.stdout)), [
      "fixture-gh",
      "fixture-github",
    ])
    assertStringIncludes(
      new TextDecoder().decode(result.stderr),
      "Development builds cannot update themselves",
    )
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test("integer Issue references without a configured team identify the config command", async () => {
  const root = await Deno.makeTempDir()
  try {
    const result = await evaluate(
      root,
      `
      import { getIssueIdentifier } from ${
        JSON.stringify(new URL("../src/utils/linear.ts", import.meta.url).href)
      };
      try { await getIssueIdentifier("123") } catch (error) {
        console.log(JSON.stringify({ message: error.message, suggestion: error.suggestion }));
      }
    `,
    )
    assertEquals(result.success, true, new TextDecoder().decode(result.stderr))
    const error = JSON.parse(new TextDecoder().decode(result.stdout))
    assertStringIncludes(error.message, "no team is set")
    assertStringIncludes(error.suggestion, "linear config")
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test("selected TOML api_key is rejected without reading credentials or exposing its value", async () => {
  const root = await Deno.makeTempDir()
  try {
    const code = `
      import { getResolvedApiKey } from ${
      JSON.stringify(new URL("../src/utils/graphql.ts", import.meta.url).href)
    };
      const read = Deno.readTextFileSync;
      Deno.readTextFileSync = (path) => {
        if (String(path).endsWith("credentials.toml")) throw new Error("credential read must not happen");
        return read(path);
      };
      try { await getResolvedApiKey() } catch (e) { console.log(e.message) }
    `
    for (
      const source of ['api_key = "DO_NOT_ECHO"\n', 'api_key = "DO_NOT_ECHO\n']
    ) {
      await Deno.writeTextFile(join(root, ".linear.toml"), source)
      const result = await evaluate(root, code, {
        LINEAR_API_KEY: "synthetic-env-key",
      })
      assertEquals(result.success, true)
      const output = new TextDecoder().decode(result.stdout)
      assertStringIncludes(output, "config file at")
      assertEquals(output.includes("DO_NOT_ECHO"), false)
      assertEquals(output.includes("credential read must not happen"), false)
      assertEquals(new TextDecoder().decode(result.stderr), "")
    }
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test("invalid bool/vcs/sort values are distinct from unset, including environment overrides", async () => {
  const root = await Deno.makeTempDir()
  try {
    const result = await evaluate(
      root,
      `
      import { getOption } from ${JSON.stringify(configUrl.href)};
      import { assertEquals, assertThrows } from "@std/assert";
      for (const name of ["issue_create_ask_project", "vcs", "issue_sort"]) {
        assertEquals(getOption(name), undefined);
        for (const value of ["", "nonsense"]) {
          Deno.env.set("LINEAR_" + name.toUpperCase(), value);
          assertThrows(() => getOption(name));
        }
        Deno.env.delete("LINEAR_" + name.toUpperCase());
      }
      assertEquals(getOption("vcs", "jj"), "jj");
      assertEquals(getOption("issue_create_ask_project", "false"), false);
    `,
    )
    assertEquals(result.success, true, new TextDecoder().decode(result.stderr))
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test("project selection rejects bare git-root config and shares the wizard's effective target", async () => {
  const root = await Deno.makeTempDir()
  try {
    const init = await new Deno.Command("git", {
      args: ["init", "--quiet", root],
    }).output()
    assertEquals(init.success, true)
    await Deno.mkdir(join(root, "sub"))
    await Deno.mkdir(join(root, ".config"))
    const nested = join(root, "sub", ".linear.toml")
    const rootConfig = join(root, ".linear.toml")
    const dotConfig = join(root, ".config", "linear.toml")
    for (const path of [nested, rootConfig, dotConfig]) {
      await Deno.writeTextFile(path, 'workspace = "synthetic"\n')
    }
    const code = `import { getProjectConfigPath } from ${
      JSON.stringify(configUrl.href)
    }; console.log(getProjectConfigPath());`
    for (const path of [nested, rootConfig, dotConfig]) {
      const result = await evaluate(join(root, "sub"), code)
      assertEquals(result.success, true)
      assertEquals(new TextDecoder().decode(result.stdout).trim(), path)
      await Deno.remove(path)
    }
    await Deno.writeTextFile(
      join(root, "linear.toml"),
      'workspace = "obsolete"',
    )
    const rejected = await evaluate(join(root, "sub"), code)
    assertEquals(rejected.success, false)
    assertStringIncludes(
      new TextDecoder().decode(rejected.stderr),
      "Unsupported project config file",
    )
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})
