import { assertEquals, assertStringIncludes } from "@std/assert"
import { MockLinearServer } from "../utils/mock_linear_server.ts"
import { commonDenoArgs } from "../utils/test-helpers.ts"

const id = "550e8400-e29b-41d4-a716-446655440100"
const organization = { id: "workspace-1", urlKey: "test" }
const emptyConnection = () => ({
  nodes: [],
  pageInfo: { hasNextPage: false, endCursor: null },
})
const metadata = { id, archivedAt: null, url: "https://linear.app/test/object" }

interface ReplacementCase {
  name: string
  command: string[]
  key: string
  viewQuery: string
  readQuery: string
  mutation: string
  payload: string
  original: Record<string, unknown>
  flags: string[]
  desired: Record<string, unknown>
  changedField: string
}

const cases: ReplacementCase[] = [
  {
    name: "Comment",
    command: ["issue", "comment"],
    key: "comment",
    viewQuery: "ReadComment",
    readQuery: "ReadComment",
    mutation: "UpdateComment",
    payload: "commentUpdate",
    original: { ...metadata, body: "Original body" },
    flags: ["--body", "Desired body"],
    desired: { body: "Desired body" },
    changedField: "body",
  },
  {
    name: "Project",
    command: ["project"],
    key: "project",
    viewQuery: "GetProjectDetails",
    readQuery: "ReadProject",
    mutation: "UpdateProject",
    payload: "projectUpdate",
    original: {
      ...metadata,
      name: "Original name",
      description: "Original description",
      startDate: null,
      targetDate: null,
      status: { id: "status-1" },
      lead: null,
      teams: emptyConnection(),
      labels: emptyConnection(),
      issues: emptyConnection(),
    },
    flags: ["--name", "Original name", "--description", "Desired description"],
    desired: { description: "Desired description" },
    changedField: "description",
  },
  {
    name: "Initiative",
    command: ["initiative"],
    key: "initiative",
    viewQuery: "GetInitiativeDetails",
    readQuery: "ReadInitiative",
    mutation: "UpdateInitiative",
    payload: "initiativeUpdate",
    original: {
      ...metadata,
      name: "Original name",
      description: "Original description",
      status: "Planned",
      targetDate: null,
      color: null,
      icon: null,
      owner: null,
      projects: emptyConnection(),
    },
    flags: ["--name", "Original name", "--description", "Desired description"],
    desired: { description: "Desired description" },
    changedField: "description",
  },
  {
    name: "Document",
    command: ["document"],
    key: "document",
    viewQuery: "GetDocumentWithComments",
    readQuery: "ReadDocument",
    mutation: "UpdateDocument",
    payload: "documentUpdate",
    original: {
      ...metadata,
      title: "Original title",
      content: "Original content",
      icon: null,
      project: null,
      comments: emptyConnection(),
    },
    flags: ["--title", "Original title", "--content", "Desired content"],
    desired: { content: "Desired content" },
    changedField: "content",
  },
  {
    name: "Milestone",
    command: ["milestone"],
    key: "projectMilestone",
    viewQuery: "GetMilestoneDetails",
    readQuery: "ReadMilestone",
    mutation: "UpdateProjectMilestone",
    payload: "projectMilestoneUpdate",
    original: {
      ...metadata,
      name: "Original name",
      description: "Original description",
      targetDate: null,
      sortOrder: 0,
      project: { id: "project-1", name: "Project" },
      issues: emptyConnection(),
    },
    flags: ["--name", "Original name", "--description", "Desired description"],
    desired: { description: "Desired description" },
    changedField: "description",
  },
]

async function cli(server: MockLinearServer, args: string[]) {
  const result = await new Deno.Command(Deno.execPath(), {
    args: ["run", ...commonDenoArgs, "src/main.ts", ...args, "--json"],
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

for (const example of cases) {
  Deno.test(`${example.name} production update consumes view basis, rejects drift, and only writes changed fields`, async () => {
    let remote = structuredClone(example.original)
    const server = new MockLinearServer([
      ...[...new Set([example.viewQuery, example.readQuery])].map((
        queryName,
      ) => ({
        queryName,
        response: () => ({ data: { organization, [example.key]: remote } }),
      })),
      {
        queryName: "DocumentInlineCommentGuard",
        response: { data: { document: { id, comments: emptyConnection() } } },
      },
      {
        queryName: example.mutation,
        response: () => {
          remote = { ...remote, ...example.desired }
          return {
            data: {
              [example.payload]: { success: true, [example.key]: remote },
            },
          }
        },
      },
    ])
    const path = await Deno.makeTempFile({ suffix: ".json" })
    try {
      await server.start()
      const read = await cli(server, [...example.command, "view", id])
      assertEquals(read.success, true, read.stderr)
      assertEquals(read.json().organization, organization)
      assertEquals(read.json()[example.key].id, id)
      await Deno.writeTextFile(path, read.stdout)

      const readCount = server.graphqlRequests.length
      const missing = await cli(server, [
        ...example.command,
        "update",
        id,
        ...example.flags,
      ])
      assertEquals(missing.code, 1)
      assertEquals(missing.json().effect, "none")
      assertEquals(
        server.graphqlRequests.length,
        readCount,
        "missing basis must fail before any remote request",
      )

      remote = { ...example.original, id: "different-object" }
      const wrongObject = await cli(server, [
        ...example.command,
        "update",
        id,
        ...example.flags,
        "--base-file",
        path,
      ])
      assertEquals(wrongObject.code, 1)
      assertEquals(wrongObject.json().effect, "none")
      assertEquals(
        server.graphqlRequests.filter((request) =>
          request.query.includes("mutation ")
        ).length,
        0,
      )

      remote = {
        ...example.original,
        [example.changedField]: "Concurrent edit",
      }
      const conflict = await cli(server, [
        ...example.command,
        "update",
        id,
        ...example.flags,
        "--base-file",
        path,
      ])
      assertEquals(conflict.code, 1)
      assertEquals(conflict.json().effect, "none")
      assertStringIncludes(conflict.stdout, "Original values changed")
      assertEquals(
        server.graphqlRequests.filter((request) =>
          request.query.includes("mutation ")
        ).length,
        0,
      )

      remote = { ...example.original, updatedAt: "2026-09-10T01:00:00Z" }
      const applied = await cli(server, [
        ...example.command,
        "update",
        id,
        ...example.flags,
        "--base-file",
        path,
      ])
      assertEquals(applied.success, true, applied.stdout + applied.stderr)
      assertEquals(applied.json().effect, "applied")
      assertEquals(applied.json().data[example.key].id, id)
      const writes = server.graphqlRequests.filter((request) =>
        request.query.includes("mutation ")
      )
      assertEquals(writes.length, 1)
      assertEquals(
        writes[0].variables,
        { id, input: example.desired },
        "no-op fields must not be sent",
      )

      const noop = await cli(server, [
        ...example.command,
        "update",
        id,
        ...example.flags,
        "--base-file",
        path,
      ])
      assertEquals(noop.success, true, noop.stderr)
      assertEquals(noop.json().effect, "none")
      const dependency = await cli(server, [
        ...example.command,
        "update",
        id,
        ...example.flags,
        "--base-file",
        path,
        "--expect-field",
        example.changedField,
      ])
      assertEquals(
        dependency.code,
        1,
        "explicit dependency must still be checked for an already-satisfied target",
      )
      assertEquals(dependency.json().effect, "none")
      assertEquals(
        server.graphqlRequests.filter((request) =>
          request.query.includes("mutation ")
        ).length,
        1,
      )
    } finally {
      await server.stop()
      await Deno.remove(path)
    }
  })
}

for (const example of cases) {
  Deno.test(`${example.name} production update preserves unknown and acknowledged effects on invalid receipts`, async () => {
    let payload: Record<string, unknown> = { success: false }
    const server = new MockLinearServer([
      {
        queryName: example.readQuery,
        response: { data: { organization, [example.key]: example.original } },
      },
      {
        queryName: "DocumentInlineCommentGuard",
        response: { data: { document: { id, comments: emptyConnection() } } },
      },
      {
        queryName: example.mutation,
        response: () => ({ data: { [example.payload]: payload } }),
      },
    ])
    try {
      await server.start()
      for (const success of [false, true]) {
        payload = { success, [example.key]: null }
        const result = await cli(server, [
          ...example.command,
          "update",
          id,
          ...example.flags,
          "--unprotected",
        ])
        assertEquals(result.code, 1)
        assertEquals(result.json().ok, false)
        assertEquals(result.json().effect, success ? "applied" : "unknown")
        assertEquals(result.json().data[example.payload].success, success)
      }
      assertEquals(
        server.graphqlRequests.filter((request) =>
          request.query.includes("mutation ")
        ).length,
        2,
        "neither failure path may automatically repeat a mutation",
      )
    } finally {
      await server.stop()
    }
  })
}

Deno.test("Document unprotected does not bypass inline anchors and force does not bypass a missing basis", async () => {
  const server = new MockLinearServer([
    {
      queryName: "ReadDocument",
      response: {
        data: {
          organization,
          document: {
            ...metadata,
            content: "Old",
            title: "Title",
            icon: null,
            project: null,
          },
        },
      },
    },
    {
      queryName: "DocumentInlineCommentGuard",
      response: {
        data: {
          document: {
            id,
            comments: {
              nodes: [{
                id: "comment-1",
                quotedText: "Old",
                resolvedAt: null,
                archivedAt: null,
              }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
    },
  ])
  try {
    await server.start()
    const force = await cli(server, [
      "document",
      "update",
      id,
      "--content",
      "New",
      "--force",
    ])
    assertEquals(force.code, 1)
    assertEquals(server.graphqlRequests.length, 0)
    const unprotected = await cli(server, [
      "document",
      "update",
      id,
      "--content",
      "New",
      "--unprotected",
    ])
    assertEquals(unprotected.code, 1)
    assertStringIncludes(unprotected.stdout, "inline comments")
    assertEquals(
      server.graphqlRequests.filter((request) =>
        request.query.includes("mutation ")
      ).length,
      0,
    )
  } finally {
    await server.stop()
  }
})

Deno.test("Document observes drift during the inline-anchor scan before mutation", async () => {
  const original = {
    ...metadata,
    content: "Old",
    title: "Title",
    icon: null,
    project: null,
  }
  let remote = original
  const server = new MockLinearServer([
    {
      queryName: "ReadDocument",
      response: () => ({ data: { organization, document: remote } }),
    },
    {
      queryName: "DocumentInlineCommentGuard",
      response: () => {
        remote = { ...original, content: "Concurrent edit during anchor scan" }
        return { data: { document: { id, comments: emptyConnection() } } }
      },
    },
  ])
  const path = await Deno.makeTempFile()
  try {
    await Deno.writeTextFile(
      path,
      JSON.stringify({ organization, document: original }),
    )
    await server.start()
    const result = await cli(server, [
      "document",
      "update",
      id,
      "--content",
      "New",
      "--base-file",
      path,
    ])
    assertEquals(result.code, 1)
    assertStringIncludes(result.stdout, "Original values changed")
    assertEquals(
      server.graphqlRequests.filter((request) =>
        request.query.includes("mutation ")
      ).length,
      0,
    )
    assertEquals(
      server.graphqlRequests.filter((request) =>
        request.query.includes("query ReadDocument")
      ).length,
      2,
    )
  } finally {
    await server.stop()
    await Deno.remove(path)
  }
})

Deno.test("Initiative update refuses an ambiguous reference without reading or writing an object", async () => {
  const server = new MockLinearServer([
    {
      queryName: "FindInitiative",
      response: {
        data: {
          initiatives: {
            nodes: [{ id: "first" }, { id: "second" }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    },
  ])
  try {
    await server.start()
    const result = await cli(server, [
      "initiative",
      "update",
      "ambiguous",
      "--name",
      "New",
      "--unprotected",
    ])
    assertEquals(result.code, 1)
    assertStringIncludes(result.stdout, "ambiguous")
    assertEquals(server.graphqlRequests.length, 1)
  } finally {
    await server.stop()
  }
})

Deno.test("Initiative JSON mode refuses interactive flags before reading an object", async () => {
  const server = new MockLinearServer()
  try {
    await server.start()
    const result = await cli(server, [
      "initiative",
      "update",
      id,
      "--interactive",
    ])
    assertEquals(result.code, 1)
    assertStringIncludes(result.stdout, "JSON mode cannot prompt")
    assertEquals(server.graphqlRequests.length, 0)
  } finally {
    await server.stop()
  }
})

Deno.test("Project basis completes teams and labels, then final scalar read catches drift during pagination", async () => {
  const project = {
    ...metadata,
    name: "Original",
    description: "Original description",
    startDate: null,
    targetDate: null,
    status: { id: "status-1" },
    lead: null,
    teams: {
      nodes: [{ id: "team-1", key: "ONE", name: "One" }],
      pageInfo: { hasNextPage: true, endCursor: "team-cursor" },
    },
    labels: {
      nodes: [{ id: "label-1", name: "First" }],
      pageInfo: { hasNextPage: true, endCursor: "label-cursor" },
    },
    issues: emptyConnection(),
  }
  let remote = project
  let updating = false
  const server = new MockLinearServer([
    ...["GetProjectDetails", "ReadProject", "ReadProjectFields"].map((
      queryName,
    ) => ({
      queryName,
      response: () => ({ data: { organization, project: remote } }),
    })),
    {
      queryName: "ReadProjectTeams",
      variables: { id, after: "team-cursor" },
      response: () => {
        if (updating) {
          remote = {
            ...project,
            description: "Concurrent edit while reading teams",
          }
        }
        return {
          data: {
            project: {
              id,
              teams: {
                nodes: [{ id: "team-2", key: "TWO", name: "Two" }],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        }
      },
    },
    {
      queryName: "ReadProjectLabels",
      variables: { id, after: "label-cursor" },
      response: {
        data: {
          project: {
            id,
            labels: {
              nodes: [{ id: "label-2", name: "Second" }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
    },
  ])
  const path = await Deno.makeTempFile()
  try {
    await server.start()
    const read = await cli(server, ["project", "view", id])
    assertEquals(read.success, true, read.stdout + read.stderr)
    assertEquals(
      read.json().project.teams.nodes.map((node: { id: string }) => node.id),
      ["team-1", "team-2"],
    )
    assertEquals(
      read.json().project.labels.nodes.map((node: { id: string }) => node.id),
      ["label-1", "label-2"],
    )
    assertEquals(read.json().project.teams.pageInfo.hasNextPage, false)
    await Deno.writeTextFile(path, read.stdout)
    updating = true
    const update = await cli(server, [
      "project",
      "update",
      id,
      "--description",
      "Desired",
      "--base-file",
      path,
      "--expect-field",
      "teams",
    ])
    assertEquals(update.code, 1)
    assertStringIncludes(update.stdout, "Original values changed")
    assertEquals(
      server.graphqlRequests.filter((request) =>
        request.query.includes("query ReadProjectFields")
      ).length,
      1,
    )
    assertEquals(
      server.graphqlRequests.filter((request) =>
        request.query.includes("mutation ")
      ).length,
      0,
    )
  } finally {
    await server.stop()
    await Deno.remove(path)
  }
})

Deno.test("Project update refuses duplicate names before any mutation", async () => {
  const server = new MockLinearServer([
    {
      queryName: "GetProjectIdByName",
      response: {
        data: {
          projects: {
            nodes: [{ id: "first" }, { id: "second" }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    },
  ])
  try {
    await server.start()
    const result = await cli(server, [
      "project",
      "update",
      "Duplicate",
      "--name",
      "New",
      "--unprotected",
    ])
    assertEquals(result.code, 1)
    assertStringIncludes(result.stdout, "ambiguous")
    assertEquals(server.graphqlRequests.length, 1)
  } finally {
    await server.stop()
  }
})

Deno.test("Document anchor scan rejects a repeated cursor instead of hanging or writing", async () => {
  const server = new MockLinearServer([
    {
      queryName: "ReadDocument",
      response: {
        data: {
          organization,
          document: {
            ...metadata,
            title: "Title",
            content: "Old",
            icon: null,
            project: null,
          },
        },
      },
    },
    {
      queryName: "DocumentInlineCommentGuard",
      response: {
        data: {
          document: {
            id,
            comments: {
              nodes: [],
              pageInfo: { hasNextPage: true, endCursor: "repeated" },
            },
          },
        },
      },
    },
  ])
  try {
    await server.start()
    const result = await cli(server, [
      "document",
      "update",
      id,
      "--content",
      "New",
      "--unprotected",
    ])
    assertEquals(result.code, 1)
    assertStringIncludes(result.stdout, "repeated pagination cursor")
    assertEquals(server.graphqlRequests.length, 3)
  } finally {
    await server.stop()
  }
})

Deno.test("Document failed clear read-back reports applied and preserves the receipt without replay", async () => {
  const document = {
    ...metadata,
    title: "Title",
    content: "Old",
    icon: null,
    project: null,
  }
  const server = new MockLinearServer([
    {
      queryName: "ReadDocument",
      response: (_request, history) =>
        history.some((request) =>
            request.query.includes("mutation UpdateDocument")
          )
          ? { errors: [{ message: "Read denied" }] }
          : { data: { organization, document } },
    },
    {
      queryName: "UpdateDocument",
      variables: { id, input: { content: "\n" } },
      response: {
        data: {
          documentUpdate: {
            success: true,
            document: { ...document, content: "" },
          },
        },
      },
    },
  ])
  try {
    await server.start()
    const result = await cli(server, [
      "document",
      "update",
      id,
      "--content=",
      "--unprotected",
      "--force",
    ])
    assertEquals(result.code, 1)
    assertEquals(result.json().ok, false)
    assertEquals(result.json().effect, "applied")
    assertEquals(result.json().data.document.id, id)
    assertEquals(
      server.graphqlRequests.filter((request) =>
        request.query.includes("mutation ")
      ).length,
      1,
    )
  } finally {
    await server.stop()
  }
})

for (const scenario of ["drift", "whitespace"] as const) {
  Deno.test({
    name:
      `Document editor captures the original basis before editing: ${scenario}`,
    ignore: Deno.build.os === "windows",
    async fn() {
      const content = " \n# Desired content\n\n "
      const original = {
        ...metadata,
        title: "Title",
        content: "Original content",
        icon: null,
        project: null,
      }
      const server = new MockLinearServer([
        {
          queryName: "ReadDocument",
          response: (_request, history) => ({
            data: {
              organization,
              document: {
                ...original,
                content: scenario === "drift" && history.filter((request) =>
                      request.query.includes("query ReadDocument")
                    ).length > 1
                  ? "Concurrent edit"
                  : original.content,
              },
            },
          }),
        },
        {
          queryName: "DocumentInlineCommentGuard",
          response: { data: { document: { id, comments: emptyConnection() } } },
        },
        {
          queryName: "UpdateDocument",
          response: {
            data: {
              documentUpdate: {
                success: true,
                document: { ...original, content },
              },
            },
          },
        },
      ])
      const directory = await Deno.makeTempDir()
      const editor = `${directory}/editor.sh`
      const config = `${directory}/gitconfig`
      try {
        await Deno.writeTextFile(
          editor,
          '#!/bin/sh\nprintf \'%s\' "$LINEAR_TEST_EDITOR_CONTENT" > "$1"\n',
        )
        await Deno.chmod(editor, 0o700)
        await Deno.writeTextFile(config, "")
        await server.start()
        const result = await new Deno.Command(Deno.execPath(), {
          args: [
            "run",
            ...commonDenoArgs,
            "src/main.ts",
            "document",
            "update",
            id,
            "--edit",
          ],
          env: {
            LINEAR_GRAPHQL_ENDPOINT: server.getEndpoint(),
            LINEAR_API_KEY: "test-token",
            NO_COLOR: "1",
            GIT_CONFIG_GLOBAL: config,
            EDITOR: editor,
            LINEAR_TEST_EDITOR_CONTENT: content,
          },
          stdin: "null",
          stdout: "piped",
          stderr: "piped",
        }).output()
        const stderr = new TextDecoder().decode(result.stderr)
        const writes = server.graphqlRequests.filter((request) =>
          request.query.includes("mutation ")
        )
        if (scenario === "drift") {
          assertEquals(result.code, 1)
          assertStringIncludes(stderr, "Original values changed")
          assertEquals(writes.length, 0)
        } else {
          assertEquals(result.success, true, stderr)
          assertEquals(writes.length, 1)
          assertEquals(
            writes[0].variables,
            { id, input: { content } },
            "editor bytes must not be trimmed",
          )
        }
      } finally {
        await server.stop()
        await Deno.remove(directory, { recursive: true })
      }
    },
  })
}
