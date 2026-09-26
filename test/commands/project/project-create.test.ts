import { snapshotTest as cliffySnapshotTest } from "@cliffy/testing"
import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert"
import { stub } from "@std/testing/mock"
import { createCommand } from "../../../src/commands/project/project-create.ts"
import { Input, Select } from "../../../src/utils/prompt.ts"
import { ValidationError } from "../../../src/utils/errors.ts"
import {
  commonDenoArgs,
  setupMockLinearServer,
} from "../../utils/test-helpers.ts"
import { MockLinearServer } from "../../utils/mock_linear_server.ts"

for (const operation of ["create", "update"]) {
  for (
    const outcome of [
      "key",
      "UUID",
      "ambiguous",
      "next-page",
      "missing",
      "unavailable",
    ]
  ) {
    Deno.test(`project ${operation} strict Team reference: ${outcome}`, async () => {
      const id = "abcdef01-2345-4678-9abc-def012345678"
      const teamId = "abcdef02-2345-4678-9abc-def012345678"
      const pageInfo = { hasNextPage: false, endCursor: null }
      const team = { id: teamId, key: "OPS" }
      const reference = outcome === "UUID" ? teamId : "oPs"
      const { server, cleanup } = await setupMockLinearServer([
        {
          queryName: "GetWriteTeamByKey",
          variables: { key: reference },
          response: outcome === "unavailable"
            ? { errors: [{ message: "Team lookup unavailable" }] }
            : {
              data: {
                teams: {
                  nodes: outcome === "missing"
                    ? []
                    : outcome === "ambiguous"
                    ? [team, { id, key: "OPS" }]
                    : [team],
                  pageInfo: outcome === "next-page"
                    ? { hasNextPage: true, endCursor: "next" }
                    : pageInfo,
                },
              },
            },
        },
        {
          queryName: "GetWriteTeamById",
          variables: { id: teamId },
          response: { data: { team } },
        },
        {
          queryName: "ReadProject",
          response: {
            data: {
              organization: { id: "workspace", urlKey: "test" },
              project: {
                id,
                name: "Original",
                teams: { nodes: [], pageInfo },
                labels: { nodes: [], pageInfo },
              },
            },
          },
        },
        {
          queryName: operation === "create" ? "CreateProject" : "UpdateProject",
          response: {
            data: {
              [operation === "create" ? "projectCreate" : "projectUpdate"]: {
                success: true,
                project: { id, name: "New" },
              },
            },
          },
        },
      ])
      try {
        const result = await new Deno.Command(Deno.execPath(), {
          args: [
            "run",
            ...commonDenoArgs,
            "src/main.ts",
            "project",
            operation,
            ...(operation === "create"
              ? ["--name", "New"]
              : [id, "--unprotected"]),
            "--team",
            reference,
            "--json",
          ],
          stdin: "null",
          stdout: "piped",
          stderr: "piped",
        }).output()
        const body = JSON.parse(new TextDecoder().decode(result.stdout))
        const success = ["key", "UUID"].includes(outcome)
        assertEquals(result.code, success ? 0 : 1, JSON.stringify(body))
        assertEquals(body.effect, success ? "applied" : "none")
        const writes = server.graphqlRequests.filter((request) =>
          request.query.includes("mutation ")
        )
        assertEquals(writes.length, success ? 1 : 0)
        if (success) {
          assertEquals(
            (writes[0].variables.input as Record<string, unknown>).teamIds,
            [teamId],
          )
        } else {
          assertStringIncludes(
            body.error.message,
            outcome === "missing"
              ? "Team not found"
              : outcome === "unavailable"
              ? "Team lookup unavailable"
              : "Team is ambiguous",
          )
        }
        assertEquals(
          server.graphqlRequests.filter((request) =>
            request.query.includes("query GetWriteTeam")
          ).map((request) => request.variables),
          [outcome === "UUID" ? { id: teamId } : { key: reference }],
        )
      } finally {
        await cleanup()
      }
    })
  }
}

Deno.test("interactive project Team selection retains its UUID without resolving its key again", async () => {
  const firstId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
  const selectedId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
  const pageInfo = { hasNextPage: false, endCursor: null }
  const { server, cleanup } = await setupMockLinearServer([
    {
      queryName: "GetAllTeams",
      response: {
        data: {
          teams: {
            nodes: [
              { id: firstId, key: "ENG", name: "Engineering" },
              { id: selectedId, key: "OPS", name: "Operations" },
            ],
            pageInfo,
          },
        },
      },
    },
    {
      queryName: "LookupUserById",
      response: { data: { users: { nodes: [{ id: firstId }], pageInfo } } },
    },
    {
      queryName: "CreateProject",
      response: {
        data: {
          projectCreate: {
            success: true,
            project: { id: firstId, name: "New" },
          },
        },
      },
    },
  ], { LINEAR_TEAM_KEY: "ENG" })
  const stdin = stub(
    Object.getPrototypeOf(Deno.stdin),
    "isTerminal",
    () => true,
  )
  const stdout = stub(
    Object.getPrototypeOf(Deno.stdout),
    "isTerminal",
    () => true,
  )
  const select = stub(
    Select,
    "prompt",
    (options: { message: string; options: unknown; default?: unknown }) => {
      assertEquals(options.message, "Team:")
      assertEquals(options.options, [
        { name: "Engineering (ENG)", value: firstId },
        { name: "Operations (OPS)", value: selectedId },
      ])
      assertEquals(options.default, firstId)
      return Promise.resolve(selectedId)
    },
  )
  const log = stub(console, "log", () => {})
  try {
    await createCommand.parse([
      "--interactive",
      "--name",
      "New",
      "--description",
      "Description",
      "--status",
      firstId,
      "--lead",
      firstId,
      "--start-date",
      "2026-01-01",
      "--target-date",
      "2026-12-31",
    ])
    const writes = server.graphqlRequests.filter((request) =>
      request.query.includes("mutation ")
    )
    assertEquals(writes.length, 1)
    assertEquals(
      (writes[0].variables.input as Record<string, unknown>).teamIds,
      [selectedId],
    )
    assertEquals(
      server.graphqlRequests.filter((request) =>
        request.query.includes("query GetWriteTeam") ||
        request.query.includes("query GetTeamIdByKey")
      ),
      [],
    )
  } finally {
    log.restore()
    select.restore()
    stdout.restore()
    stdin.restore()
    await cleanup()
  }
})

const descriptionFilePath = await Deno.makeTempFile({ suffix: ".md" })
await Deno.writeTextFile(
  descriptionFilePath,
  "Short description loaded from a file.",
)

for (
  const fields of [
    ["name", "status", "priority"],
    ["lead", "team", "label", "member"],
    ["start-date", "target-date"],
    ["description-file", "content-file"],
  ]
) {
  Deno.test(`project create rejects explicit empty ${fields.join("/")} before requests`, async () => {
    const server = new MockLinearServer()
    await server.start()
    try {
      for (const field of fields) {
        const result = await new Deno.Command(Deno.execPath(), {
          args: [
            "run",
            "--allow-all",
            "--quiet",
            "src/main.ts",
            "project",
            "create",
            ...(field === "name" ? [] : ["--name", "Example"]),
            ...(field === "team" ? [] : ["--team", "ENG"]),
            `--${field}`,
            "",
            "--json",
          ],
          env: {
            LINEAR_API_KEY: "test-token",
            LINEAR_GRAPHQL_ENDPOINT: server.getEndpoint(),
          },
        }).output()
        assertEquals(result.code, 1, new TextDecoder().decode(result.stdout))
        assertEquals(server.graphqlRequests, [])
      }
    } finally {
      await server.stop()
    }
  })
}

for (const field of ["description", "content"]) {
  Deno.test(`project create empty ${field} still conflicts with file`, async () => {
    const server = new MockLinearServer()
    await server.start()
    try {
      const result = await new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "--allow-all",
          "--quiet",
          "src/main.ts",
          "project",
          "create",
          "--name",
          "Example",
          "--team",
          "ENG",
          `--${field}`,
          "",
          `--${field}-file`,
          descriptionFilePath,
          "--json",
        ],
        env: {
          LINEAR_API_KEY: "test-token",
          LINEAR_GRAPHQL_ENDPOINT: server.getEndpoint(),
        },
      }).output()
      assertEquals(result.code, 1)
      assertEquals(
        new TextDecoder().decode(result.stdout).includes(`--${field}`),
        true,
      )
      assertEquals(server.graphqlRequests, [])
    } finally {
      await server.stop()
    }
  })
}

Deno.test("project create preserves empty inline bodies in mutation", async () => {
  const server = new MockLinearServer([
    {
      queryName: "GetWriteTeamByKey",
      response: {
        data: {
          teams: {
            nodes: [{ id: "team-eng", key: "ENG" }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    },
    {
      queryName: "CreateProject",
      response: {
        data: {
          projectCreate: {
            success: true,
            project: {
              id: "550e8400-e29b-41d4-a716-446655440000",
              name: "Example",
            },
          },
        },
      },
    },
  ])
  await server.start()
  try {
    const result = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-all",
        "--quiet",
        "src/main.ts",
        "project",
        "create",
        "--name",
        "Example",
        "--team",
        "ENG",
        "--description",
        "",
        "--content",
        "",
        "--json",
      ],
      env: {
        LINEAR_API_KEY: "test-token",
        LINEAR_GRAPHQL_ENDPOINT: server.getEndpoint(),
      },
    }).output()
    assertEquals(result.code, 0, new TextDecoder().decode(result.stdout))
    assertEquals(server.graphqlRequests.at(-1)?.variables.input, {
      name: "Example",
      teamIds: ["team-eng"],
      description: "",
      content: "",
    })
  } finally {
    await server.stop()
  }
})

Deno.test("project create rejects explicit empty inputs before interactive prompts", async () => {
  const { server, cleanup } = await setupMockLinearServer([])
  const stdin = stub(
    Object.getPrototypeOf(Deno.stdin),
    "isTerminal",
    () => true,
  )
  const terminal = stub(
    Object.getPrototypeOf(Deno.stdout),
    "isTerminal",
    () => true,
  )
  const input = stub(Input, "prompt", () => Promise.resolve("unexpected"))
  const select = stub(Select, "prompt", () => Promise.resolve("unexpected"))
  const errors = stub(console, "error", () => {})
  const exit = stub(Deno, "exit", () => {
    throw new Error("EXIT")
  })
  try {
    for (
      const args of [["--name", ""], ["--team", ""], ["--status", ""], [
        "--description",
        "",
        "--description-file",
        descriptionFilePath,
      ]]
    ) {
      await assertRejects(
        () => createCommand.parse(["--interactive", ...args]),
        Error,
        "EXIT",
      )
    }
    assertEquals(input.calls.length, 0)
    assertEquals(select.calls.length, 0)
    assertEquals(server.graphqlRequests, [])
  } finally {
    exit.restore()
    errors.restore()
    select.restore()
    input.restore()
    terminal.restore()
    stdin.restore()
    await cleanup()
  }
})

for (const json of [false, true]) {
  Deno.test(`project create refuses explicit interaction without a terminal: json=${json}`, async () => {
    const server = new MockLinearServer([])
    try {
      await server.start()
      const result = await new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          ...commonDenoArgs,
          "src/main.ts",
          "project",
          "create",
          "--name",
          "Example",
          "--team",
          "ENG",
          "--interactive",
          ...(json ? ["--json"] : []),
        ],
        env: {
          LINEAR_API_KEY: "test-token",
          LINEAR_GRAPHQL_ENDPOINT: server.getEndpoint(),
        },
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      }).output()
      assertEquals(result.code, 1)
      assertEquals(server.graphqlRequests, [])
      if (json) {
        assertEquals(
          JSON.parse(new TextDecoder().decode(result.stdout)).effect,
          "none",
        )
      }
    } finally {
      await server.stop()
    }
  })
}

for (const stdinTerminal of [false, true]) {
  Deno.test(`project JSON never implicitly prompts on terminal stdout: stdin=${stdinTerminal}`, async () => {
    const code = `
      import { cli } from "./src/cli.ts";
      import { Input } from "./src/utils/prompt.ts";
      Deno.stdout.isTerminal = () => true;
      Deno.stdin.isTerminal = () => ${stdinTerminal};
      Input.prompt = () => { throw new Error("unexpected prompt"); };
      globalThis.fetch = () => { throw new Error("unexpected transport"); };
      await cli.parse(["project", "create", "--json"]);
    `
    const result = await new Deno.Command(Deno.execPath(), {
      args: ["eval", "--quiet", code],
      env: { LINEAR_API_KEY: "test-token" },
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output()
    assertEquals(result.code, 1)
    const output = JSON.parse(new TextDecoder().decode(result.stdout))
    assertEquals(output.effect, "none")
    assertEquals(
      output.error.message.includes("Project name is required"),
      true,
    )
  })
}

// Test project create reading description from --description-file
await cliffySnapshotTest({
  name: "Project Create Command - Description From File",
  meta: import.meta,
  colors: false,
  args: [
    "--name",
    "File Desc Project",
    "--team",
    "ENG",
    "--description-file",
    descriptionFilePath,
    "--json",
  ],
  denoArgs: commonDenoArgs,
  async fn() {
    const server = new MockLinearServer([
      {
        queryName: "GetWriteTeamByKey",
        variables: { key: "ENG" },
        response: {
          data: {
            teams: {
              nodes: [{ id: "team-eng-123", key: "ENG" }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
      {
        queryName: "CreateProject",
        response: {
          data: {
            projectCreate: {
              success: true,
              project: {
                id: "550e8400-e29b-41d4-a716-446655440010",
                slugId: "file-desc-project",
                name: "File Desc Project",
                url: "https://linear.app/test/project/file-desc-project",
              },
            },
          },
        },
      },
    ])

    try {
      await server.start()
      Deno.env.set("LINEAR_GRAPHQL_ENDPOINT", server.getEndpoint())
      Deno.env.set("LINEAR_API_KEY", "Bearer test-token")

      await createCommand.parse()
    } finally {
      await server.stop()
      Deno.env.delete("LINEAR_GRAPHQL_ENDPOINT")
      Deno.env.delete("LINEAR_API_KEY")
    }
  },
})

// Test project create with --json output
await cliffySnapshotTest({
  name: "Project Create Command - With JSON Output",
  meta: import.meta,
  colors: false,
  args: [
    "--name",
    "JSON Test Project",
    "--team",
    "ENG",
    "--json",
  ],
  denoArgs: commonDenoArgs,
  async fn() {
    const server = new MockLinearServer([
      {
        queryName: "GetWriteTeamByKey",
        variables: { key: "ENG" },
        response: {
          data: {
            teams: {
              nodes: [{ id: "team-eng-123", key: "ENG" }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
      {
        queryName: "CreateProject",
        response: {
          data: {
            projectCreate: {
              success: true,
              project: {
                id: "550e8400-e29b-41d4-a716-446655440000",
                slugId: "json-test-project",
                name: "JSON Test Project",
                url: "https://linear.app/test/project/json-test-project",
              },
            },
          },
        },
      },
    ])

    try {
      await server.start()
      Deno.env.set("LINEAR_GRAPHQL_ENDPOINT", server.getEndpoint())
      Deno.env.set("LINEAR_API_KEY", "Bearer test-token")

      await createCommand.parse()
    } finally {
      await server.stop()
      Deno.env.delete("LINEAR_GRAPHQL_ENDPOINT")
      Deno.env.delete("LINEAR_API_KEY")
    }
  },
})

// Test project create with overview content and GraphQL-backed fields
await cliffySnapshotTest({
  name: "Project Create Command - With Content And Create Fields",
  meta: import.meta,
  colors: false,
  args: [
    "--name",
    "Detailed Project",
    "--team",
    "ENG",
    "--description",
    "Short project description",
    "--content",
    "## Overview\nShip the new project experience.",
    "--lead",
    "lead@example.com",
    "--start-date",
    "2026-06-01",
    "--target-date",
    "2026-09-30",
    "--priority",
    "high",
    "--label",
    "Frontend",
    "--label",
    "Backend",
    "--member",
    "jane@example.com",
    "--member",
    "@me",
    "--icon",
    "rocket",
    "--color",
    "#5E6AD2",
    "--json",
  ],
  denoArgs: commonDenoArgs,
  async fn() {
    const server = new MockLinearServer([
      {
        queryName: "GetWriteTeamByKey",
        variables: { key: "ENG" },
        response: {
          data: {
            teams: {
              nodes: [{ id: "team-eng-123", key: "ENG" }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
      {
        queryName: "LookupUser",
        variables: { filter: { email: { eqIgnoreCase: "lead@example.com" } } },
        response: {
          data: {
            users: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [{
                id: "user-lead-123",
                email: "lead@example.com",
                displayName: "Project Lead",
                name: "lead",
              }],
            },
          },
        },
      },
      {
        queryName: "GetProjectLabelIdByName",
        variables: { name: "Frontend" },
        response: {
          data: {
            projectLabels: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [{ id: "project-label-frontend", name: "Frontend" }],
            },
          },
        },
      },
      {
        queryName: "GetProjectLabelIdByName",
        variables: { name: "Backend" },
        response: {
          data: {
            projectLabels: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [{ id: "project-label-backend", name: "Backend" }],
            },
          },
        },
      },
      {
        queryName: "LookupUser",
        variables: { filter: { email: { eqIgnoreCase: "jane@example.com" } } },
        response: {
          data: {
            users: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [{
                id: "user-jane-123",
                email: "jane@example.com",
                displayName: "Jane Developer",
                name: "jane",
              }],
            },
          },
        },
      },
      {
        queryName: "GetViewerId",
        variables: {},
        response: {
          data: {
            viewer: {
              id: "user-self-123",
            },
          },
        },
      },
      {
        queryName: "CreateProject",
        variables: {
          input: {
            name: "Detailed Project",
            teamIds: ["team-eng-123"],
            description: "Short project description",
            content: "## Overview\nShip the new project experience.",
            leadId: "user-lead-123",
            startDate: "2026-06-01",
            targetDate: "2026-09-30",
            priority: 2,
            labelIds: ["project-label-frontend", "project-label-backend"],
            memberIds: ["user-jane-123", "user-self-123"],
            icon: "rocket",
            color: "#5E6AD2",
          },
        },
        response: {
          data: {
            projectCreate: {
              success: true,
              project: {
                id: "550e8400-e29b-41d4-a716-446655440010",
                slugId: "detailed-project",
                name: "Detailed Project",
                url: "https://linear.app/test/project/detailed-project",
              },
            },
          },
        },
      },
    ])

    try {
      await server.start()
      Deno.env.set("LINEAR_GRAPHQL_ENDPOINT", server.getEndpoint())
      Deno.env.set("LINEAR_API_KEY", "Bearer test-token")

      await createCommand.parse()
    } finally {
      await server.stop()
      Deno.env.delete("LINEAR_GRAPHQL_ENDPOINT")
      Deno.env.delete("LINEAR_API_KEY")
    }
  },
})

// Test project create with content read from a file
await cliffySnapshotTest({
  name: "Project Create Command - With Content File",
  meta: import.meta,
  colors: false,
  args: [
    "--name",
    "File Content Project",
    "--team",
    "ENG",
    "--content-file",
    "placeholder-replaced-in-test.md",
    "--json",
  ],
  denoArgs: commonDenoArgs,
  async fn() {
    const overviewPath = await Deno.makeTempFile({
      prefix: "linear-project-overview-",
      suffix: ".md",
    })

    const server = new MockLinearServer([
      {
        queryName: "GetWriteTeamByKey",
        variables: { key: "ENG" },
        response: {
          data: {
            teams: {
              nodes: [{ id: "team-eng-123", key: "ENG" }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
      {
        queryName: "CreateProject",
        variables: {
          input: {
            name: "File Content Project",
            teamIds: ["team-eng-123"],
            content:
              "# Project Overview\n\nThis overview came from a markdown file.\n",
          },
        },
        response: {
          data: {
            projectCreate: {
              success: true,
              project: {
                id: "550e8400-e29b-41d4-a716-446655440011",
                slugId: "file-content-project",
                name: "File Content Project",
                url: "https://linear.app/test/project/file-content-project",
              },
            },
          },
        },
      },
    ])

    let contentFileArgIndex = -1
    let originalContentFileArg: string | undefined

    try {
      await Deno.writeTextFile(
        overviewPath,
        "# Project Overview\n\nThis overview came from a markdown file.\n",
      )
      contentFileArgIndex = Deno.args.indexOf(
        "placeholder-replaced-in-test.md",
      )
      if (contentFileArgIndex === -1) {
        throw new Error("Expected content file placeholder argument")
      }
      originalContentFileArg = Deno.args[contentFileArgIndex]
      Deno.args[contentFileArgIndex] = overviewPath
      await server.start()
      Deno.env.set("LINEAR_GRAPHQL_ENDPOINT", server.getEndpoint())
      Deno.env.set("LINEAR_API_KEY", "Bearer test-token")

      await createCommand.parse()
    } finally {
      await server.stop()
      Deno.env.delete("LINEAR_GRAPHQL_ENDPOINT")
      Deno.env.delete("LINEAR_API_KEY")
      if (contentFileArgIndex !== -1 && originalContentFileArg != null) {
        Deno.args[contentFileArgIndex] = originalContentFileArg
      }
      await Deno.remove(overviewPath)
    }
  },
})

// Invalid --priority is rejected by the shared CLI type before action or transport.
Deno.test("Project Create Command - rejects an invalid priority", async () => {
  const { server, cleanup } = await setupMockLinearServer([])
  try {
    await assertRejects(
      () =>
        createCommand.parse([
          "--name",
          "Proj",
          "--team",
          "ENG",
          "--priority",
          "highest",
        ]),
      ValidationError,
      "Invalid priority: highest",
    )
    assertEquals(server.graphqlRequests, [])
  } finally {
    await cleanup()
  }
})

// An unknown --label is reported as a NotFoundError.
Deno.test("Project Create Command - rejects an unknown project label", async () => {
  const server = new MockLinearServer([
    {
      queryName: "GetWriteTeamByKey",
      variables: { key: "ENG" },
      response: {
        data: {
          teams: {
            nodes: [{ id: "team-eng-123", key: "ENG" }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    },
    {
      queryName: "GetProjectLabelIdByName",
      variables: { name: "Nonexistent" },
      response: {
        data: {
          projectLabels: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [],
          },
        },
      },
    },
  ])

  const errorLogs: string[] = []
  const errorStub = stub(console, "error", (...args: unknown[]) => {
    errorLogs.push(args.map(String).join(" "))
  })
  const exitStub = stub(Deno, "exit", (_code?: number) => {
    throw new Error("EXIT")
  })

  let exited = false
  try {
    await server.start()
    Deno.env.set("LINEAR_GRAPHQL_ENDPOINT", server.getEndpoint())
    Deno.env.set("LINEAR_API_KEY", "Bearer test-token")
    await createCommand.parse([
      "--name",
      "Proj",
      "--team",
      "ENG",
      "--label",
      "Nonexistent",
    ])
  } catch (e) {
    if (!(e instanceof Error) || e.message !== "EXIT") throw e
    exited = true
  } finally {
    errorStub.restore()
    exitStub.restore()
    await server.stop()
    Deno.env.delete("LINEAR_GRAPHQL_ENDPOINT")
    Deno.env.delete("LINEAR_API_KEY")
  }

  assertEquals(exited, true)
  // Full NotFoundError message — a mock mismatch could not produce this exact text.
  assertEquals(
    errorLogs.some((l) => l.includes("Project label not found: Nonexistent")),
    true,
  )
})

// An unknown --member is reported as a NotFoundError.
Deno.test("Project Create Command - rejects an unknown member", async () => {
  const server = new MockLinearServer([
    {
      queryName: "GetWriteTeamByKey",
      variables: { key: "ENG" },
      response: {
        data: {
          teams: {
            nodes: [{ id: "team-eng-123", key: "ENG" }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    },
    {
      queryName: "LookupUser",
      response: {
        data: {
          users: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [],
          },
        },
      },
    },
  ])

  const errorLogs: string[] = []
  const errorStub = stub(console, "error", (...args: unknown[]) => {
    errorLogs.push(args.map(String).join(" "))
  })
  const exitStub = stub(Deno, "exit", (_code?: number) => {
    throw new Error("EXIT")
  })

  let exited = false
  try {
    await server.start()
    Deno.env.set("LINEAR_GRAPHQL_ENDPOINT", server.getEndpoint())
    Deno.env.set("LINEAR_API_KEY", "Bearer test-token")
    await createCommand.parse([
      "--name",
      "Proj",
      "--team",
      "ENG",
      "--member",
      "ghostuser",
    ])
  } catch (e) {
    if (!(e instanceof Error) || e.message !== "EXIT") throw e
    exited = true
  } finally {
    errorStub.restore()
    exitStub.restore()
    await server.stop()
    Deno.env.delete("LINEAR_GRAPHQL_ENDPOINT")
    Deno.env.delete("LINEAR_API_KEY")
  }

  assertEquals(exited, true)
  // Full NotFoundError message — a mock-mismatch error would echo the variable
  // "ghostuser" but never this exact "User not found:" text.
  assertEquals(
    errorLogs.some((l) => l.includes("User not found: ghostuser")),
    true,
  )
})
