import { assertEquals, assertStringIncludes } from "@std/assert"
import { MockLinearServer } from "../../utils/mock_linear_server.ts"
import { commonDenoArgs } from "../../utils/test-helpers.ts"

const id = "550e8400-e29b-41d4-a716-446655440100"
const organization = { id: "workspace-1", urlKey: "test" }
const emptyConnection = () => ({
  nodes: [],
  pageInfo: { hasNextPage: false, endCursor: null },
})
const project = {
  id,
  name: "Project",
  description: "Short description",
  content: "Original overview\n",
  archivedAt: null,
  url: "https://linear.app/test/project/example",
  teams: emptyConnection(),
  labels: emptyConnection(),
  issues: emptyConnection(),
}

async function cli(server: MockLinearServer, args: string[]) {
  const result = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      ...commonDenoArgs,
      "src/main.ts",
      "project",
      ...args,
      "--json",
    ],
    env: {
      LINEAR_GRAPHQL_ENDPOINT: server.getEndpoint(),
      LINEAR_API_KEY: "test-token",
      NO_COLOR: "1",
    },
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output()
  const stdout = new TextDecoder().decode(result.stdout)
  const stderr = new TextDecoder().decode(result.stderr)
  return { ...result, stdout, stderr, json: () => JSON.parse(stdout) }
}

for (const operation of ["create", "update"]) {
  for (const field of ["description", "content"]) {
    for (
      const source of [
        "inline",
        "file",
        "empty-file",
        "invalid-file",
        ...(field === "description" ? ["255-file", "256-file"] : []),
      ]
    ) {
      Deno.test(`project ${operation} ${field} preserves ${source}`, async () => {
        const expected = source === "empty-file"
          ? ""
          : source === "255-file"
          ? "\uFEFF" + "x".repeat(254)
          : source === "256-file"
          ? "\uFEFF" + "x".repeat(255)
          : "\uFEFF \r\nAlpha  \r\n\tBeta\n \t"
        const file = await Deno.makeTempFile()
        let remote = structuredClone(project)
        const server = new MockLinearServer([
          {
            queryName: "GetWriteTeamByKey",
            response: {
              data: {
                teams: {
                  nodes: [{ id: "team-id", key: "ENG" }],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
          {
            queryName: "ReadProject",
            response: () => ({ data: { organization, project: remote } }),
          },
          {
            queryName: operation === "create"
              ? "CreateProject"
              : "UpdateProject",
            response: ({ variables }) => {
              const input = variables.input as Record<string, unknown>
              remote = {
                ...remote,
                ...input,
                ...(input.content === "\n" ? { content: "" } : {}),
              }
              return {
                data: {
                  [operation === "create" ? "projectCreate" : "projectUpdate"]:
                    { success: true, project: remote },
                },
              }
            },
          },
        ])
        try {
          await Deno.writeFile(
            file,
            source === "invalid-file"
              ? new Uint8Array([0x41, 0xc3, 0x28, 0x42])
              : new TextEncoder().encode(expected),
          )
          await server.start()
          const result = await cli(server, [
            operation,
            ...(operation === "create"
              ? ["--name", "New", "--team", "ENG"]
              : [id, "--unprotected"]),
            ...(source === "inline"
              ? [`--${field}`, expected]
              : [`--${field}-file`, file]),
          ])
          const valid = source !== "invalid-file" && source !== "256-file"
          assertEquals(
            result.code,
            valid ? 0 : 1,
            result.stdout + result.stderr,
          )
          const writes = server.graphqlRequests.filter((request) =>
            request.query.includes("mutation ")
          )
          assertEquals(writes.length, valid ? 1 : 0)
          if (valid) {
            assertEquals(result.json().effect, "applied")
            assertEquals(
              (writes[0].variables.input as Record<string, unknown>)[field],
              operation === "update" && field === "content" && expected === ""
                ? "\n"
                : expected,
            )
          } else {
            assertEquals(result.json().effect, "none")
            assertStringIncludes(
              result.json().error.message,
              source === "invalid-file"
                ? `Failed to read ${field} file`
                : "256 characters",
            )
            assertEquals(server.graphqlRequests, [])
          }
        } finally {
          await server.stop()
          await Deno.remove(file)
        }
      })
    }
  }
}

for (const observation of ["empty", "different", "unavailable"] as const) {
  Deno.test(`Project clear content preserves its receipt separately from ${observation} read-back`, async () => {
    let reads = 0
    const receipt = {
      id,
      name: "Receipt name",
      content: "\n",
      url: project.url,
    }
    const server = new MockLinearServer([
      {
        queryName: "ReadProject",
        response: () => {
          if (++reads > 1 && observation === "unavailable") {
            return { errors: [{ message: "Read-back unavailable" }] }
          }
          return {
            data: {
              organization,
              project: {
                ...project,
                content: reads === 1
                  ? "Original"
                  : observation === "empty"
                  ? ""
                  : "Concurrent edit",
              },
            },
          }
        },
      },
      {
        queryName: "UpdateProject",
        response: {
          data: { projectUpdate: { success: true, project: receipt } },
        },
      },
    ])
    try {
      await server.start()
      const result = await cli(server, [
        "update",
        id,
        "--unprotected",
        "--content",
        "",
      ])
      const body = result.json()
      assertEquals(
        result.code,
        observation === "empty" ? 0 : 1,
        result.stdout + result.stderr,
      )
      assertEquals(body.effect, "applied")
      assertEquals(body.data.project, receipt)
      if (observation === "empty") {
        assertEquals(body.verification, { status: "verified", content: "" })
      } else {
        assertStringIncludes(body.error.message, "could not be verified")
        assertEquals(body.error.details.verification.status, "unverified")
      }
      assertEquals(reads, 2)
      assertEquals(
        server.graphqlRequests.filter((request) =>
          request.query.includes("mutation ")
        ).map((request) => request.variables),
        [{ id, input: { content: "\n" } }],
      )
    } finally {
      await server.stop()
    }
  })
}

Deno.test("Project content uses the view basis, rejects concurrent edits, preserves Markdown, and clears explicitly", async () => {
  let remote = structuredClone(project)
  const server = new MockLinearServer([
    {
      queryName: "GetProjectDetails",
      variables: { id, includeContent: true },
      queryIncludes: "content",
      response: () => ({ data: { organization, project: remote } }),
    },
    {
      queryName: "ReadProject",
      queryIncludes: "content",
      response: () => ({ data: { organization, project: remote } }),
    },
    {
      queryName: "UpdateProject",
      queryIncludes: "content",
      response: ({ variables }) => {
        const input = variables.input as Record<string, unknown>
        remote = {
          ...remote,
          ...input,
          // Linear normalizes LF to an empty Markdown body on write.
          ...(input.content === "\n" && { content: "" }),
        }
        return {
          data: { projectUpdate: { success: true, project: remote } },
        }
      },
    },
  ])
  const directory = await Deno.makeTempDir()
  const basis = `${directory}/original.json`
  const draft = `${directory}/desired.md`
  const desired = `\n# Overview\n\n${"Long content. ".repeat(30)}\n\n` +
    "[Member](https://linear.app/test/profiles/member)\n\n" +
    "```text\nliteral \\n stays literal\n```\n\n"
  const mutations = () =>
    server.graphqlRequests.filter((request) =>
      request.query.includes("mutation UpdateProject")
    )
  try {
    await server.start()
    const read = await cli(server, ["view", id])
    assertEquals(read.code, 0, read.stdout + read.stderr)
    assertEquals(read.json().project.content, project.content)
    await Deno.writeTextFile(basis, read.stdout)
    await Deno.writeTextFile(draft, desired)
    const args = [
      "update",
      id,
      "--base-file",
      basis,
      "--content-file",
      draft,
      "--description",
      project.description,
    ]

    // A basis that never contained the content is not an empty original body.
    const missing = read.json()
    delete missing.project.content
    await Deno.writeTextFile(basis, JSON.stringify(missing))
    const absent = await cli(server, args)
    assertEquals(absent.code, 1)
    assertEquals(absent.json().effect, "none")
    assertStringIncludes(absent.json().error.message, "missing field content")
    assertEquals(mutations().length, 0)
    await Deno.writeTextFile(basis, read.stdout)

    remote.content = "Someone else's edit\n"
    const conflict = await cli(server, args)
    assertEquals(conflict.code, 1)
    assertEquals(conflict.json().effect, "none")
    assertStringIncludes(
      conflict.json().error.message,
      "Original values changed",
    )
    assertEquals(mutations().length, 0)

    remote = structuredClone(project)
    const write = await cli(server, args)
    assertEquals(write.code, 0, write.stdout + write.stderr)
    assertEquals(write.json().effect, "applied")
    assertEquals(write.json().data.project.content, desired)
    assertEquals(mutations().map((request) => request.variables), [
      { id, input: { content: desired } },
    ])
    const noOp = await cli(server, args)
    assertEquals(noOp.code, 0, noOp.stdout + noOp.stderr)
    assertEquals(noOp.json().effect, "none")
    assertEquals(mutations().length, 1)

    const beforeClear = await cli(server, ["view", id])
    await Deno.writeTextFile(basis, beforeClear.stdout)
    const clear = await cli(server, [
      "update",
      id,
      "--base-file",
      basis,
      "--content=",
    ])
    assertEquals(clear.code, 0, clear.stdout + clear.stderr)
    assertEquals(clear.json().data.project.content, "")
    assertEquals(mutations()[1].variables, { id, input: { content: "\n" } })
  } finally {
    await server.stop()
    await Deno.remove(directory, { recursive: true })
  }
})

Deno.test("Project content input validation rejects missing basis and invalid files before transport", async () => {
  const server = new MockLinearServer([])
  const directory = await Deno.makeTempDir()
  try {
    await server.start()
    for (
      const args of [
        ["--content", "Desired"],
        ["--unprotected", "--content-file", ""],
        ["--unprotected", "--content-file", `${directory}/missing.md`],
        ["--unprotected", "--content", "", "--content-file", "draft.md"],
      ]
    ) {
      const result = await cli(server, ["update", id, ...args])
      assertEquals(result.code, 1, result.stdout + result.stderr)
      assertEquals(result.json().effect, "none")
      assertEquals(server.graphqlRequests, [])
    }
  } finally {
    await server.stop()
    await Deno.remove(directory, { recursive: true })
  }
})
