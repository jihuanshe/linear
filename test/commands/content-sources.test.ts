import { assertEquals, assertStringIncludes } from "@std/assert"
import { join } from "@std/path"
import { MockLinearServer } from "../utils/mock_linear_server.ts"
import { commonDenoArgs } from "../utils/test-helpers.ts"

const id = "11111111-1111-4111-8111-111111111111"
const raw =
  "\uFEFF  indented\r\nline  \r\n\r\n- parent\r\n  - child\r\n\\n\r\n\r\n"
const organization = { id: "workspace-1", urlKey: "test" }
const cases = [
  {
    args: ["document", "create", "--title", "Spec", "--project", id],
    field: "content",
    mutation: "CreateDocument",
    payload: "documentCreate",
    object: "document",
  },
  {
    args: ["document", "update", id, "--force", "--unprotected"],
    field: "content",
    mutation: "UpdateDocument",
    payload: "documentUpdate",
    object: "document",
  },
  {
    args: ["initiative", "create", "--name", "Work"],
    field: "content",
    mutation: "CreateInitiative",
    payload: "initiativeCreate",
    object: "initiative",
  },
  {
    args: ["initiative", "update", id, "--unprotected"],
    field: "content",
    mutation: "UpdateInitiativeWithContent",
    payload: "initiativeUpdate",
    object: "initiative",
  },
  {
    args: ["project-update", "create", id],
    field: "body",
    mutation: "CreateProjectUpdate",
    payload: "projectUpdateCreate",
    object: "projectUpdate",
  },
  {
    args: ["initiative-update", "create", id],
    field: "body",
    mutation: "CreateInitiativeUpdate",
    payload: "initiativeUpdateCreate",
    object: "initiativeUpdate",
  },
  {
    args: ["issue", "comment", "add", "ENG-1"],
    field: "body",
    mutation: "AddComment",
    payload: "commentCreate",
    object: "comment",
  },
  {
    args: ["issue", "comment", "update", id, "--unprotected"],
    field: "body",
    mutation: "UpdateComment",
    payload: "commentUpdate",
    object: "comment",
  },
]

for (const command of cases) {
  Deno.test(`${command.args.slice(0, 2).join(" ")} transmits raw sources and rejects unreadable or competing sources`, async () => {
    const dir = await Deno.makeTempDir()
    const file = join(dir, "source.md")
    const invalid = join(dir, "invalid.md")
    const empty = join(dir, "empty.md")
    await Deno.writeTextFile(file, raw)
    await Deno.writeTextFile(empty, "")
    await Deno.writeFile(invalid, new Uint8Array([0xc3, 0x28]))
    const server = new MockLinearServer([
      {
        queryName: "GetIssueId",
        response: { data: { issue: { id } } },
      },
      {
        queryName: "ReadComment",
        response: {
          data: {
            organization,
            comment: { id, body: "before", archivedAt: null },
          },
        },
      },
      {
        queryName: "ReadDocument",
        response: {
          data: {
            organization,
            document: {
              id,
              content: "before",
              title: "Before",
              archivedAt: null,
            },
          },
        },
      },
      {
        queryName: "ReadInitiative",
        response: {
          data: {
            organization,
            initiatives: {
              nodes: [{
                id,
                content: "before",
                name: "Before",
                archivedAt: null,
              }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
      {
        queryName: "GetInitiativeNameForStatusUpdate",
        response: { data: { initiative: { name: "Work" } } },
      },
      {
        queryName: command.mutation,
        response: {
          data: {
            [command.payload]: {
              success: true,
              [command.object]: {
                id,
                url: "https://linear.app/test",
                name: "Work",
                title: "Spec",
                issue: { id },
              },
            },
          },
        },
      },
    ])
    try {
      await server.start()
      const inputs = [
        { args: [`--${command.field}`, raw], expected: raw },
        { args: [`--${command.field}-file`, file], expected: raw },
        { args: [`--${command.field}-file`, "-"], expected: raw, stdin: raw },
        { args: [`--${command.field}-file`, invalid], error: "Failed to read" },
        {
          args: [`--${command.field}-file`, join(dir, "missing")],
          error: "Failed to read",
        },
        { args: [`--${command.field}-file`, dir], error: "Failed to read" },
        {
          args: [`--${command.field}`, "", `--${command.field}-file`, file],
          error: command.object === "document" && command.args[1] === "update"
            ? "Use only one"
            : "both",
        },
        ...(command.args[0].endsWith("-update")
          ? [
            { args: ["--health", "onTrack"], expected: undefined },
            { args: ["--body", "", "--health", "onTrack"], expected: "" },
            {
              args: ["--body-file", empty, "--health", "onTrack"],
              expected: "",
            },
          ]
          : []),
      ]
      for (const input of inputs) {
        const before = server.graphqlRequests.length
        const child = new Deno.Command(Deno.execPath(), {
          args: [
            "run",
            ...commonDenoArgs,
            "src/main.ts",
            ...command.args,
            ...input.args,
            "--json",
          ],
          env: {
            LINEAR_API_KEY: "test-key",
            LINEAR_GRAPHQL_ENDPOINT: server.getEndpoint(),
          },
          stdin: "piped",
          stdout: "piped",
          stderr: "piped",
        }).spawn()
        const writer = child.stdin.getWriter()
        if (input.stdin != null) {
          await writer.write(new TextEncoder().encode(input.stdin))
        }
        await writer.close()
        const result = await child.output()
        const out = new TextDecoder().decode(result.stdout)
        assertEquals(
          result.code,
          input.error ? 1 : 0,
          out + new TextDecoder().decode(result.stderr),
        )
        if (input.error) {
          assertStringIncludes(JSON.parse(out).error.message, input.error)
          assertEquals(server.graphqlRequests.length, before)
        } else {
          const writes = server.graphqlRequests.slice(before).filter((r) =>
            r.query.includes(`mutation ${command.mutation}(`)
          )
          assertEquals(writes.length, 1)
          assertEquals(
            (writes[0].variables.input as Record<string, unknown>)[
              command.field
            ],
            input.expected,
          )
        }
      }
    } finally {
      await server.stop()
      await Deno.remove(dir, { recursive: true })
    }
  })
}
