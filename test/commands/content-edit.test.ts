import { assertEquals } from "@std/assert"
import { join } from "@std/path"
import { MockLinearServer } from "../utils/mock_linear_server.ts"
import { commonDenoArgs } from "../utils/test-helpers.ts"

const id = "11111111-1111-4111-8111-111111111111"
const initial = "  Seed  \r\n\\n\r\n\r\n"
const desired = "  Changed  \r\n- a\r\n  - b\r\n\\n\r\n\r\n"
const organization = { id: "workspace-1", urlKey: "test" }

for (const object of ["document", "comment", "initiative"]) {
  Deno.test({
    name:
      `${object} explicit editor captures original basis before editing, preserves text and rejects concurrent changes`,
    ignore: Deno.build.os === "windows",
    async fn() {
      const dir = await Deno.makeTempDir()
      const editor = join(dir, "editor")
      const config = join(dir, "gitconfig")
      const seen = join(dir, "seen")
      const replacement = join(dir, "replacement")
      await Deno.writeTextFile(config, "")
      await Deno.writeTextFile(replacement, desired)
      await Deno.writeTextFile(
        editor,
        `#!/bin/sh\ncp "$1" '${seen}'\ncp '${replacement}' "$1"\n`,
      )
      await Deno.chmod(editor, 0o700)
      const field = object === "comment" ? "body" : "content"
      const readName = object === "document"
        ? "ReadDocument"
        : object === "comment"
        ? "ReadComment"
        : "ReadInitiative"
      const mutation = object === "document"
        ? "UpdateDocument"
        : object === "comment"
        ? "UpdateComment"
        : "UpdateInitiativeWithContent"
      let reads = 0
      let changed = false
      const server = new MockLinearServer([
        {
          queryName: readName,
          response: () => {
            const entity = {
              id,
              [field]: changed && reads++ > 0 ? "Concurrent edit" : initial,
              title: "Title",
              name: "Name",
              archivedAt: null,
            }
            return {
              data: {
                organization,
                ...(object === "initiative"
                  ? {
                    initiatives: {
                      nodes: [entity],
                      pageInfo: { hasNextPage: false },
                    },
                  }
                  : { [object]: entity }),
              },
            }
          },
        },
        {
          queryName: mutation,
          response: {
            data: {
              [`${object}Update`]: {
                success: true,
                [object]: {
                  id,
                  [field]: desired,
                  url: "https://linear.app/test",
                },
              },
            },
          },
        },
      ])
      try {
        server.start()
        for (const conflict of [false, true]) {
          changed = conflict
          reads = 0
          const before = server.graphqlRequests.length
          const args = object === "comment"
            ? ["issue", "comment", "update", id]
            : [object, "update", id]
          const result = await new Deno.Command(Deno.execPath(), {
            args: [
              "run",
              ...commonDenoArgs,
              "src/main.ts",
              ...args,
              "--edit",
              ...(object === "document" ? ["--force"] : []),
            ],
            env: {
              LINEAR_API_KEY: "test-key",
              LINEAR_GRAPHQL_ENDPOINT: server.getEndpoint(),
              EDITOR: editor,
              GIT_CONFIG_GLOBAL: config,
            },
            stdin: "null",
            stdout: "piped",
            stderr: "piped",
          }).output()
          assertEquals(
            result.code,
            conflict ? 1 : 0,
            new TextDecoder().decode(result.stderr),
          )
          assertEquals(await Deno.readTextFile(seen), initial)
          const writes = server.graphqlRequests.slice(before).filter((r) =>
            r.query.includes("mutation")
          )
          assertEquals(writes.length, conflict ? 0 : 1)
          if (!conflict) {
            assertEquals(writes[0].variables, {
              id,
              input: { [field]: desired },
            })
          }
        }
      } finally {
        await server.stop()
        await Deno.remove(dir, { recursive: true })
      }
    },
  })
}

Deno.test("terminal presence never implicitly opens an editor or prompts for missing content", async () => {
  const server = new MockLinearServer([
    {
      queryName: "CreateDocument",
      response: {
        data: {
          documentCreate: {
            success: true,
            document: { id, title: "Spec", url: "https://linear.app/test" },
          },
        },
      },
    },
    {
      queryName: "CreateInitiative",
      response: {
        data: {
          initiativeCreate: {
            success: true,
            initiative: { id, name: "Work", url: "https://linear.app/test" },
          },
        },
      },
    },
    {
      queryName: "CreateProjectUpdate",
      response: {
        data: {
          projectUpdateCreate: {
            success: true,
            projectUpdate: {
              id,
              health: "onTrack",
              url: "https://linear.app/test",
            },
          },
        },
      },
    },
    {
      queryName: "GetInitiativeNameForStatusUpdate",
      response: { data: { initiative: { name: "Work" } } },
    },
    {
      queryName: "CreateInitiativeUpdate",
      response: {
        data: {
          initiativeUpdateCreate: {
            success: true,
            initiativeUpdate: {
              id,
              health: "onTrack",
              url: "https://linear.app/test",
            },
          },
        },
      },
    },
  ])
  try {
    server.start()
    for (
      const args of [
        ["document", "create", "--title", "Spec", "--project", id],
        ["initiative", "create", "--name", "Work"],
        ["project-update", "create", id, "--health", "onTrack"],
        ["initiative-update", "create", id, "--health", "onTrack"],
        ["issue", "comment", "add", "ENG-1"],
        ["issue", "comment", "update", id],
      ]
    ) {
      const code = `import { cli } from './src/cli.ts';
        import { Input, Select } from './src/utils/prompt.ts';
        Deno.stdin.isTerminal = Deno.stdout.isTerminal = () => true;
        Input.prompt = Select.prompt = () => { throw new Error('Unexpected prompt'); };
        Deno.Command = class { constructor() { throw new Error('Unexpected process'); } };
        await cli.parse(${JSON.stringify(args)});`
      const before = server.graphqlRequests.length
      const result = await new Deno.Command(Deno.execPath(), {
        args: ["eval", "--quiet", code],
        env: {
          LINEAR_API_KEY: "test-key",
          LINEAR_GRAPHQL_ENDPOINT: server.getEndpoint(),
          NO_COLOR: "1",
          EDITOR: "/missing/editor",
        },
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      }).output()
      const comment = args[0] === "issue"
      assertEquals(
        result.code,
        comment ? 1 : 0,
        new TextDecoder().decode(result.stderr),
      )
      const writes = server.graphqlRequests.slice(before).filter((r) =>
        r.query.includes("mutation")
      )
      assertEquals(writes.length, comment ? 0 : 1)
      if (!comment) {
        const input = writes[0].variables.input as Record<string, unknown>
        assertEquals("body" in input, false)
        assertEquals("content" in input, false)
      }
    }
  } finally {
    await server.stop()
  }
})
