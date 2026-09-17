import { assertEquals, assertStringIncludes } from "@std/assert"
import { fromFileUrl, join } from "@std/path"
import { parse } from "@std/toml"
import { MockLinearServer } from "../utils/mock_linear_server.ts"

const cache = await new Deno.Command(Deno.execPath(), {
  args: ["info", "--json"],
  stdout: "piped",
  stderr: "piped",
}).output()
const denoDir = JSON.parse(new TextDecoder().decode(cache.stdout)).denoDir

Deno.test("config wizard selects a team UUID but writes only its team_key", async () => {
  const root = await Deno.makeTempDir()
  const team = {
    id: "11111111-1111-4111-8111-111111111111",
    key: "ENG",
    name: "Engineering",
  }
  const server = new MockLinearServer([{
    queryName: "Config",
    response: {
      data: {
        viewer: { organization: { urlKey: "fixture-workspace" } },
        teams: { nodes: [team] },
      },
    },
  }])
  try {
    server.start()
    const result = await new Deno.Command(Deno.execPath(), {
      args: [
        "eval",
        "--quiet",
        `--config=${fromFileUrl(new URL("../../deno.json", import.meta.url))}`,
        `
          import { cli } from ${
          JSON.stringify(new URL("../../src/cli.ts", import.meta.url).href)
        };
          import { Select } from ${
          JSON.stringify(
            new URL("../../src/utils/prompt.ts", import.meta.url).href,
          )
        };
          import { assertEquals } from "@std/assert";
          Deno.stdin.isTerminal = () => true;
          const messages = [];
          Select.prompt = (options) => {
            messages.push(options.message);
            if (options.message === "Select a team:") {
              assertEquals(options.options, [{ name: "Engineering (ENG)", value: ${
          JSON.stringify(team.id)
        } }]);
              return Promise.resolve(${JSON.stringify(team.id)});
            }
            assertEquals(options.message, "Select sort order:");
            return Promise.resolve("priority");
          };
          await cli.parse(["config"]);
          assertEquals(messages, ["Select a team:", "Select sort order:"]);
        `,
      ],
      cwd: root,
      clearEnv: true,
      env: {
        HOME: root,
        XDG_CONFIG_HOME: join(root, "global"),
        APPDATA: join(root, "global"),
        DENO_DIR: denoDir,
        PATH: Deno.env.get("PATH") ?? "",
        SystemRoot: Deno.env.get("SystemRoot") ?? "",
        NO_COLOR: "1",
        LINEAR_API_KEY: "synthetic-env-key",
        LINEAR_GRAPHQL_ENDPOINT: server.getEndpoint(),
      },
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output()
    assertEquals(result.success, true, new TextDecoder().decode(result.stderr))
    assertEquals(new TextDecoder().decode(result.stderr), "")
    assertEquals(parse(await Deno.readTextFile(join(root, ".linear.toml"))), {
      workspace: "fixture-workspace",
      team_key: team.key,
      issue_sort: "priority",
    })
    assertEquals(server.graphqlRequests.length, 1)
  } finally {
    await server.stop()
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test("config wizard refuses every selected existing project file before prompting or network", async () => {
  const root = await Deno.makeTempDir()
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
