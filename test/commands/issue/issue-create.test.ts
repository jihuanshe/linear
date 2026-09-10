import {
  setupIssueWriteServer as setupMockLinearServer,
  teamWriteIds,
} from "../../utils/issue-write-fixtures.ts"
import { snapshotTest } from "@cliffy/testing"
import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert"
import { Checkbox, Input, Select } from "@cliffy/prompt"
import { stub } from "@std/testing/mock"
import { stripIgnoredCharacters } from "graphql"
import { createCommand } from "../../../src/commands/issue/issue-create.ts"
import { ValidationError } from "../../../src/utils/errors.ts"
import { commonDenoArgs } from "../../utils/test-helpers.ts"

for (
  const args of [
    ...[
      "assignee",
      "due-date",
      "parent",
      "team",
      "project",
      "state",
      "milestone",
      "cycle",
      "title",
      "label",
      "description-file",
    ].map((flag) => [`--${flag}`, ""]),
    ["--label", "valid", "--label", ""],
    ["--description", "", "--description-file", "body.md"],
  ]
) {
  Deno.test(`create CLI rejects explicit empty options ${JSON.stringify(args)}`, async () => {
    const { server, cleanup } = await setupMockLinearServer([])
    try {
      const result = await new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          ...commonDenoArgs,
          "src/main.ts",
          "issue",
          "create",
          "--json",
          ...(args.includes("--title") ? [] : ["--title", "Valid title"]),
          "--priority",
          "2",
          ...args,
        ],
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      }).output()
      const body = JSON.parse(new TextDecoder().decode(result.stdout))
      assertEquals(result.code, 1)
      assertEquals(body.effect, "none")
      assertStringIncludes(
        body.error.message,
        args.includes("--description") ? "both" : "empty",
      )
      assertEquals(server.graphqlRequests, [])
    } finally {
      await cleanup()
    }
  })
}

Deno.test("create CLI preserves a legal explicit empty description", async () => {
  const { server, cleanup } = await setupMockLinearServer([
    {
      queryName: "GetTeamIdByKey",
      variables: { team: "ENG" },
      response: { data: { teams: { nodes: [{ id: teamWriteIds.ENG }] } } },
    },
    {
      queryName: "CreateIssue",
      response: {
        data: {
          issueCreate: {
            success: true,
            issue: {
              id: "issue-id",
              identifier: "ENG-123",
              url: "https://linear.app/test/issue/ENG-123",
              team: { key: "ENG" },
            },
          },
        },
      },
    },
  ], { LINEAR_TEAM_ID: "ENG", LINEAR_ISSUE_CREATE_ASSIGN_SELF: "never" })
  try {
    const result = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        ...commonDenoArgs,
        "src/main.ts",
        "issue",
        "create",
        "--json",
        "--title",
        "Empty description",
        "--description",
        "",
      ],
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output()
    assertEquals(result.code, 0, new TextDecoder().decode(result.stdout))
    const writes = server.graphqlRequests.filter((request) =>
      request.query.includes("mutation CreateIssue")
    )
    assertEquals(writes.length, 1)
    assertEquals(
      (writes[0].variables.input as Record<string, unknown>).description,
      "",
    )
  } finally {
    await cleanup()
  }
})

for (
  const args of [
    ["--assignee", ""],
    ["--assignee", " \n"],
    ...[
      "due-date",
      "parent",
      "team",
      "project",
      "state",
      "milestone",
      "cycle",
      "title",
      "label",
      "description-file",
    ].map((flag) => [`--${flag}`, ""]),
    ["--description", "", "--description-file", "body.md"],
  ]
) {
  Deno.test(`interactive create rejects explicit blank options ${JSON.stringify(args)} before prompts or defaults`, async () => {
    const { server, cleanup } = await setupMockLinearServer([], {
      LINEAR_TEAM_ID: "ENG",
      LINEAR_ISSUE_CREATE_ASSIGN_SELF: "always",
    })
    const stdout = stub(
      Object.getPrototypeOf(Deno.stdout),
      "isTerminal",
      () => true,
    )
    const stdin = stub(
      Object.getPrototypeOf(Deno.stdin),
      "isTerminal",
      () => true,
    )
    const prompt = stub(Input, "prompt", () => {
      throw new Error("Unexpected prompt")
    })
    try {
      await assertRejects(
        () => createCommand.parse(args),
        ValidationError,
        args.includes("--description") ? "both" : "empty",
      )
      assertEquals(prompt.calls.length, 0)
      assertEquals(server.graphqlRequests, [])
    } finally {
      prompt.restore()
      stdin.restore()
      stdout.restore()
      await cleanup()
    }
  })
}

for (const outcome of ["found", "missing", "error"] as const) {
  Deno.test(`Issue Create Command - UUID assignee ${outcome} overrides default self only after lookup`, async () => {
    const userId = "abcdef01-2345-4678-9abc-def012345678"
    const { server, cleanup } = await setupMockLinearServer([
      {
        queryName: "GetTeamIdByKey",
        variables: { team: "ENG" },
        response: { data: { teams: { nodes: [{ id: teamWriteIds.ENG }] } } },
      },
      {
        queryName: "GetViewerId",
        response: { data: { viewer: { id: "user-self-123" } } },
      },
      {
        queryName: "LookupUserById",
        variables: { id: userId },
        response: outcome === "error"
          ? { errors: [{ message: "User lookup unavailable" }] }
          : {
            data: {
              users: { nodes: outcome === "found" ? [{ id: userId }] : [] },
            },
          },
      },
      {
        queryName: "CreateIssue",
        response: {
          data: {
            issueCreate: {
              success: true,
              issue: {
                id: "issue-id",
                identifier: "ENG-123",
                url: "https://linear.app/test/issue/ENG-123",
                team: { key: "ENG" },
              },
            },
          },
        },
      },
    ], { LINEAR_TEAM_ID: "ENG", LINEAR_ISSUE_CREATE_ASSIGN_SELF: "always" })
    const logs: string[] = []
    const logStub = stub(console, "log", () => {})
    const errorStub = stub(
      console,
      "error",
      (...args: unknown[]) => logs.push(args.join(" ")),
    )
    const exitStub = stub(Deno, "exit", () => {
      throw new Error("EXIT")
    })
    try {
      const args = [
        "--title",
        "Assigned by UUID",
        "--team",
        "ENG",
        "--assignee",
        userId.toUpperCase(),
        "--no-interactive",
        "--json",
      ]
      if (outcome === "found") {
        try {
          await createCommand.parse(args)
        } catch (cause) {
          throw new Error(logs.join("\n"), { cause })
        }
      } else {
        await assertRejects(() => createCommand.parse(args), Error, "EXIT")
        assertStringIncludes(
          logs.join("\n"),
          outcome === "missing" ? "User not found:" : "User lookup unavailable",
        )
      }
      const lookup = server.graphqlRequests.find((request) =>
        request.query.includes("query LookupUserById")
      )
      assertEquals(lookup?.variables, { id: userId })
      assertStringIncludes(
        stripIgnoredCharacters(lookup?.query ?? ""),
        "filter:{id:{eq:$id}}",
      )
      assertEquals(
        server.graphqlRequests.some((request) =>
          /query LookupUser\(/.test(request.query)
        ),
        false,
      )
      const mutations = server.graphqlRequests.filter((request) =>
        request.query.includes("mutation ")
      )
      assertEquals(mutations.length, outcome === "found" ? 1 : 0)
      if (outcome === "found") {
        assertEquals(
          (mutations[0].variables.input as { assigneeId: string }).assigneeId,
          userId,
        )
      }
    } finally {
      logStub.restore()
      errorStub.restore()
      exitStub.restore()
      await cleanup()
    }
  })
}

// Test help output
await snapshotTest({
  name: "Issue Create Command - Help Text",
  meta: import.meta,
  colors: false,
  args: ["--help"],
  denoArgs: commonDenoArgs,
  async fn() {
    createCommand.help({ colors: false })
    await createCommand.parse()
  },
})

// Test creating an issue with flags (happy path)
await snapshotTest({
  name: "Issue Create Command - Happy Path",
  meta: import.meta,
  colors: false,
  args: [
    "--title",
    "Fix authentication bug",
    "--description",
    "Users are experiencing login issues",
    "--assignee",
    "self",
    "--priority",
    "2",
    "--estimate",
    "3",
    "--team",
    "ENG",
    "--no-interactive",
  ],
  denoArgs: commonDenoArgs,
  async fn() {
    const { cleanup } = await setupMockLinearServer([
      // Mock response for getTeamIdByKey() - converting team key to ID
      {
        queryName: "GetTeamIdByKey",
        variables: { team: "ENG" },
        response: {
          data: {
            teams: {
              nodes: [{ id: teamWriteIds.ENG }],
            },
          },
        },
      },
      // Mock response for lookupUserId("self") - resolves to viewer
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
      // Mock response for the create issue mutation
      {
        queryName: "CreateIssue",
        response: {
          data: {
            issueCreate: {
              success: true,
              issue: {
                id: "issue-new-456",
                identifier: "ENG-123",
                url:
                  "https://linear.app/test-team/issue/ENG-123/fix-authentication-bug",
                team: {
                  key: "ENG",
                },
              },
            },
          },
        },
      },
    ], { LINEAR_TEAM_ID: "ENG" })

    try {
      await createCommand.parse()
    } finally {
      await cleanup()
    }
  },
})

// Test creating an issue with milestone
await snapshotTest({
  name: "Issue Create Command - With Milestone",
  meta: import.meta,
  colors: false,
  args: [
    "--title",
    "Test milestone feature",
    "--team",
    "ENG",
    "--project",
    "My Project",
    "--milestone",
    "Phase 1",
    "--no-interactive",
  ],
  denoArgs: commonDenoArgs,
  async fn() {
    const { cleanup } = await setupMockLinearServer([
      {
        queryName: "ProjectTeams",
        response: {
          data: {
            project: {
              id: "project-id",
              name: "Project",
              teams: {
                nodes: [{
                  id: teamWriteIds.ENG,
                  key: "ENG",
                  name: "Engineering",
                }],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        },
      },
      // Mock response for getTeamIdByKey()
      {
        queryName: "GetTeamIdByKey",
        variables: { team: "ENG" },
        response: {
          data: {
            teams: {
              nodes: [{ id: teamWriteIds.ENG }],
            },
          },
        },
      },
      // Mock response for getProjectIdByName()
      {
        queryName: "GetProjectIdByName",
        variables: { name: "My Project" },
        response: {
          data: {
            projects: {
              nodes: [{ id: "project-123" }],
            },
          },
        },
      },
      // Mock response for getMilestoneIdByName()
      {
        queryName: "GetProjectMilestonesForLookup",
        variables: { projectId: "project-123" },
        response: {
          data: {
            project: {
              projectMilestones: {
                nodes: [
                  { id: "milestone-1", name: "Phase 1" },
                  { id: "milestone-2", name: "Phase 2" },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        },
      },
      // Mock response for the create issue mutation
      {
        queryName: "CreateIssue",
        response: {
          data: {
            issueCreate: {
              success: true,
              issue: {
                id: "issue-new-milestone",
                identifier: "ENG-789",
                url:
                  "https://linear.app/test-team/issue/ENG-789/test-milestone-feature",
                team: {
                  key: "ENG",
                },
              },
            },
          },
        },
      },
    ], { LINEAR_TEAM_ID: "ENG" })

    try {
      await createCommand.parse()
    } finally {
      await cleanup()
    }
  },
})

// Test creating an issue with case-insensitive label matching
await snapshotTest({
  name: "Issue Create Command - Case Insensitive Label Matching",
  meta: import.meta,
  colors: false,
  args: [
    "--title",
    "Test case insensitive labels",
    "--description",
    "Testing label matching",
    "--label",
    "BUG", // uppercase label that should match "bug" label
    "--team",
    "ENG",
    "--no-interactive",
  ],
  denoArgs: commonDenoArgs,
  async fn() {
    const { cleanup } = await setupMockLinearServer([
      // Mock response for getTeamIdByKey() - converting team key to ID
      {
        queryName: "GetTeamIdByKey",
        variables: { team: "ENG" },
        response: {
          data: {
            teams: {
              nodes: [{ id: teamWriteIds.ENG }],
            },
          },
        },
      },
      // Mock response for getIssueLabelIdByNameForTeam("BUG", "ENG") - case insensitive
      {
        queryName: "GetIssueLabelIdByNameForTeam",
        variables: { name: "BUG", team: { id: { eq: teamWriteIds.ENG } } },
        response: {
          data: {
            issueLabels: {
              nodes: [{
                id: "label-bug-123",
                name: "bug", // actual label is lowercase
              }],
            },
          },
        },
      },
      // Mock response for the create issue mutation
      {
        queryName: "CreateIssue",
        response: {
          data: {
            issueCreate: {
              success: true,
              issue: {
                id: "issue-new-789",
                identifier: "ENG-456",
                url:
                  "https://linear.app/test-team/issue/ENG-456/test-case-insensitive-labels",
                team: {
                  key: "ENG",
                },
              },
            },
          },
        },
      },
    ], { LINEAR_TEAM_ID: "ENG" })

    try {
      await createCommand.parse()
    } finally {
      await cleanup()
    }
  },
})

// Test that -p is priority (not parent), resolving the flag conflict
await snapshotTest({
  name: "Issue Create Command - Short Flag -p Is Priority",
  meta: import.meta,
  colors: false,
  args: [
    "--title",
    "Test priority flag",
    "--team",
    "ENG",
    "-p",
    "2",
    "--parent",
    "ENG-220",
    "--no-interactive",
  ],
  denoArgs: commonDenoArgs,
  async fn() {
    const { cleanup } = await setupMockLinearServer([
      // Mock response for getTeamIdByKey()
      {
        queryName: "GetTeamIdByKey",
        variables: { team: "ENG" },
        response: {
          data: {
            teams: {
              nodes: [{ id: teamWriteIds.ENG }],
            },
          },
        },
      },
      // Mock response for getIssueId("ENG-220") - resolves parent identifier to ID
      {
        queryName: "GetIssueId",
        variables: { id: "ENG-220" },
        response: {
          data: {
            issue: {
              id: "parent-issue-id",
            },
          },
        },
      },
      // Mock response for fetchParentIssueData("parent-issue-id")
      {
        queryName: "GetParentIssueData",
        variables: { id: "parent-issue-id" },
        response: {
          data: {
            issue: {
              title: "Parent Issue",
              identifier: "ENG-220",
              project: null,
            },
          },
        },
      },
      // Mock response for the create issue mutation
      {
        queryName: "CreateIssue",
        response: {
          data: {
            issueCreate: {
              success: true,
              issue: {
                id: "issue-new-priority",
                identifier: "ENG-999",
                url:
                  "https://linear.app/test-team/issue/ENG-999/test-priority-flag",
                team: {
                  key: "ENG",
                },
              },
            },
          },
        },
      },
    ], { LINEAR_TEAM_ID: "ENG" })

    try {
      await createCommand.parse()
    } finally {
      await cleanup()
    }
  },
})

// Test creating an issue with cycle
await snapshotTest({
  name: "Issue Create Command - With Cycle",
  meta: import.meta,
  colors: false,
  args: [
    "--title",
    "Test cycle feature",
    "--team",
    "ENG",
    "--cycle",
    "active",
    "--no-interactive",
  ],
  denoArgs: commonDenoArgs,
  async fn() {
    const { cleanup } = await setupMockLinearServer([
      // Mock response for getTeamIdByKey()
      {
        queryName: "GetTeamIdByKey",
        variables: { team: "ENG" },
        response: {
          data: {
            teams: {
              nodes: [{ id: teamWriteIds.ENG }],
            },
          },
        },
      },
      // Mock response for getCycleIdByNameOrNumber("active")
      {
        queryName: "GetTeamCyclesForLookup",
        variables: { teamId: teamWriteIds.ENG },
        response: {
          data: {
            team: {
              key: "ENG",
              cyclesEnabled: true,
              cycles: {
                nodes: [
                  {
                    id: "cycle-1",
                    number: 7,
                    startsAt: "2026-07-27T07:00:00.000Z",
                    name: "Sprint 7",
                  },
                  {
                    id: "cycle-2",
                    number: 8,
                    startsAt: "2026-07-27T07:00:00.000Z",
                    name: "Sprint 8",
                  },
                ],
              },
              activeCycle: {
                id: "cycle-1",
                number: 7,
                startsAt: "2026-07-27T07:00:00.000Z",
                name: "Sprint 7",
              },
            },
          },
        },
      },
      // Mock response for the create issue mutation
      {
        queryName: "CreateIssue",
        response: {
          data: {
            issueCreate: {
              success: true,
              issue: {
                id: "issue-new-cycle",
                identifier: "ENG-890",
                url:
                  "https://linear.app/test-team/issue/ENG-890/test-cycle-feature",
                team: {
                  key: "ENG",
                },
              },
            },
          },
        },
      },
    ], { LINEAR_TEAM_ID: "ENG" })

    try {
      await createCommand.parse()
    } finally {
      await cleanup()
    }
  },
})

Deno.test("Issue Create Command - Explicit Project Still Uses Interactive Mode", async () => {
  const { cleanup } = await setupMockLinearServer([
    {
      queryName: "ProjectTeams",
      response: {
        data: {
          project: {
            id: "project-id",
            name: "Project",
            teams: {
              nodes: [{
                id: teamWriteIds.ENG,
                key: "ENG",
                name: "Engineering",
              }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
    },
    {
      queryName: "GetUserSettings",
      response: {
        data: {
          userSettings: {
            autoAssignToSelf: false,
          },
        },
      },
    },
    {
      queryName: "GetProjectIdByName",
      variables: { name: "Dashboard" },
      response: {
        data: {
          projects: {
            nodes: [{ id: "project-123" }],
          },
        },
      },
    },
    {
      queryName: "GetTeamIdByKey",
      variables: { team: "ENG" },
      response: {
        data: {
          teams: {
            nodes: [{ id: teamWriteIds.ENG }],
          },
        },
      },
    },
    {
      queryName: "GetWorkflowStates",
      variables: { teamKey: teamWriteIds.ENG },
      response: {
        data: {
          team: {
            states: {
              nodes: [],
            },
          },
        },
      },
    },
    {
      queryName: "GetLabelsForTeam",
      response: {
        data: {
          team: {
            labels: {
              nodes: [],
            },
          },
        },
      },
    },
    {
      queryName: "CreateIssue",
      variables: {
        input: {
          title: "Create dashboard issue",
          labelIds: [],
          teamId: teamWriteIds.ENG,
          projectId: "project-123",
          useDefaultTemplate: true,
        },
      },
      response: {
        data: {
          issueCreate: {
            success: true,
            issue: {
              id: "issue-interactive-project",
              identifier: "ENG-901",
              url:
                "https://linear.app/test-team/issue/ENG-901/create-dashboard-issue",
              team: {
                key: "ENG",
              },
            },
          },
        },
      },
    },
  ], { LINEAR_TEAM_ID: "ENG" })

  const stdoutTerminalStub = stub(
    Object.getPrototypeOf(Deno.stdout),
    "isTerminal",
    () => true,
  )
  const stdinTerminalStub = stub(
    Object.getPrototypeOf(Deno.stdin),
    "isTerminal",
    () => true,
  )
  const inputStub = stub(
    Input,
    "prompt",
    (options: string | { message: string }) => {
      const message = typeof options === "string" ? options : options.message
      if (message === "What's the title of your issue?") {
        return Promise.resolve("Create dashboard issue")
      }
      if (message.startsWith("Description")) {
        return Promise.resolve("")
      }
      throw new Error(`Unexpected Input.prompt call: ${message}`)
    },
  )
  let selectCallCount = 0
  const selectStub = stub(Select, "prompt", (options: { message: string }) => {
    selectCallCount += 1
    if (options.message === "What's next?") {
      return Promise.resolve("submit")
    }
    throw new Error(`Unexpected Select.prompt call: ${options.message}`)
  })

  try {
    await createCommand.parse(["--project", "Dashboard"])
    assertEquals(selectCallCount, 1)
  } finally {
    selectStub.restore()
    inputStub.restore()
    stdinTerminalStub.restore()
    stdoutTerminalStub.restore()
    await cleanup()
  }
})

Deno.test("Issue Create Command - Interactive Project Prompt Uses Team Projects", async () => {
  const { cleanup } = await setupMockLinearServer([
    {
      queryName: "ProjectTeams",
      response: {
        data: {
          project: {
            id: "project-id",
            name: "Project",
            teams: {
              nodes: [{
                id: teamWriteIds.ENG,
                key: "ENG",
                name: "Engineering",
              }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
    },
    {
      queryName: "GetUserSettings",
      response: {
        data: {
          userSettings: {
            autoAssignToSelf: false,
          },
        },
      },
    },
    {
      queryName: "GetTeamIdByKey",
      variables: { team: "ENG" },
      response: {
        data: {
          teams: {
            nodes: [{ id: teamWriteIds.ENG }],
          },
        },
      },
    },
    {
      queryName: "GetProjectsForTeam",
      response: {
        data: {
          projects: {
            nodes: [{ id: "project-456", name: "Dashboard" }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    },
    {
      queryName: "GetWorkflowStates",
      variables: { teamKey: teamWriteIds.ENG },
      response: {
        data: {
          team: {
            states: {
              nodes: [],
            },
          },
        },
      },
    },
    {
      queryName: "GetLabelsForTeam",
      response: {
        data: {
          team: {
            labels: {
              nodes: [],
            },
          },
        },
      },
    },
    {
      queryName: "CreateIssue",
      variables: {
        input: {
          title: "Issue with prompted project",
          labelIds: [],
          teamId: teamWriteIds.ENG,
          projectId: "project-456",
          useDefaultTemplate: true,
        },
      },
      response: {
        data: {
          issueCreate: {
            success: true,
            issue: {
              id: "issue-project-prompt",
              identifier: "ENG-902",
              url:
                "https://linear.app/test-team/issue/ENG-902/issue-with-prompted-project",
              team: {
                key: "ENG",
              },
            },
          },
        },
      },
    },
  ], {
    LINEAR_TEAM_ID: "ENG",
    LINEAR_ISSUE_CREATE_ASK_PROJECT: "true",
  })

  const stdoutTerminalStub = stub(
    Object.getPrototypeOf(Deno.stdout),
    "isTerminal",
    () => true,
  )
  const stdinTerminalStub = stub(
    Object.getPrototypeOf(Deno.stdin),
    "isTerminal",
    () => true,
  )
  const inputStub = stub(
    Input,
    "prompt",
    (options: string | { message: string }) => {
      const message = typeof options === "string" ? options : options.message
      if (message === "What's the title of your issue?") {
        return Promise.resolve("Issue with prompted project")
      }
      if (message.startsWith("Description")) {
        return Promise.resolve("")
      }
      throw new Error(`Unexpected Input.prompt call: ${message}`)
    },
  )
  const selectStub = stub(Select, "prompt", (options: { message: string }) => {
    if (options.message === "Which project should this issue belong to?") {
      return Promise.resolve("project-456")
    }
    if (options.message === "What's next?") {
      return Promise.resolve("submit")
    }
    if (
      options.message ===
        "Start working on this issue now? (creates branch and updates status)"
    ) {
      return Promise.resolve(false)
    }
    throw new Error(`Unexpected Select.prompt call: ${options.message}`)
  })

  try {
    await createCommand.parse([])
  } finally {
    selectStub.restore()
    inputStub.restore()
    stdinTerminalStub.restore()
    stdoutTerminalStub.restore()
    await cleanup()
  }
})

Deno.test("Issue Create Command - Additional Fields Can Set Project", async () => {
  const { cleanup } = await setupMockLinearServer([
    {
      queryName: "ProjectTeams",
      response: {
        data: {
          project: {
            id: "project-id",
            name: "Project",
            teams: {
              nodes: [{
                id: teamWriteIds.ENG,
                key: "ENG",
                name: "Engineering",
              }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
    },
    {
      queryName: "GetUserSettings",
      response: {
        data: {
          userSettings: {
            autoAssignToSelf: false,
          },
        },
      },
    },
    {
      queryName: "GetTeamIdByKey",
      variables: { team: "ENG" },
      response: {
        data: {
          teams: {
            nodes: [{ id: teamWriteIds.ENG }],
          },
        },
      },
    },
    {
      queryName: "GetWorkflowStates",
      variables: { teamKey: teamWriteIds.ENG },
      response: {
        data: {
          team: {
            states: {
              nodes: [],
            },
          },
        },
      },
    },
    {
      queryName: "GetLabelsForTeam",
      response: {
        data: {
          team: {
            labels: {
              nodes: [],
            },
          },
        },
      },
    },
    {
      queryName: "GetProjectsForTeam",
      response: {
        data: {
          projects: {
            nodes: [{ id: "project-789", name: "Dashboard" }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    },
    {
      queryName: "CreateIssue",
      variables: {
        input: {
          title: "Issue from more fields",
          labelIds: [],
          teamId: teamWriteIds.ENG,
          projectId: "project-789",
          useDefaultTemplate: true,
        },
      },
      response: {
        data: {
          issueCreate: {
            success: true,
            issue: {
              id: "issue-more-fields",
              identifier: "ENG-903",
              url:
                "https://linear.app/test-team/issue/ENG-903/issue-from-more-fields",
              team: {
                key: "ENG",
              },
            },
          },
        },
      },
    },
  ], { LINEAR_TEAM_ID: "ENG" })

  const stdoutTerminalStub = stub(
    Object.getPrototypeOf(Deno.stdout),
    "isTerminal",
    () => true,
  )
  const stdinTerminalStub = stub(
    Object.getPrototypeOf(Deno.stdin),
    "isTerminal",
    () => true,
  )
  const inputStub = stub(
    Input,
    "prompt",
    (options: string | { message: string }) => {
      const message = typeof options === "string" ? options : options.message
      if (message === "What's the title of your issue?") {
        return Promise.resolve("Issue from more fields")
      }
      if (message.startsWith("Description")) {
        return Promise.resolve("")
      }
      throw new Error(`Unexpected Input.prompt call: ${message}`)
    },
  )
  const checkboxStub = stub(
    Checkbox,
    "prompt",
    (options: { message: string }) => {
      if (options.message === "Select additional fields to configure") {
        return Promise.resolve(["project"])
      }
      throw new Error(`Unexpected Checkbox.prompt call: ${options.message}`)
    },
  )
  const selectStub = stub(Select, "prompt", (options: { message: string }) => {
    if (options.message === "What's next?") {
      return Promise.resolve("more_fields")
    }
    if (options.message === "Which project should this issue belong to?") {
      return Promise.resolve("project-789")
    }
    if (
      options.message ===
        "Start working on this issue now? (creates branch and updates status)"
    ) {
      return Promise.resolve(false)
    }
    throw new Error(`Unexpected Select.prompt call: ${options.message}`)
  })

  try {
    await createCommand.parse([])
  } finally {
    selectStub.restore()
    checkboxStub.restore()
    inputStub.restore()
    stdinTerminalStub.restore()
    stdoutTerminalStub.restore()
    await cleanup()
  }
})

for (const mode of ["flags", "interactive"] as const) {
  Deno.test(`Issue Create Command - Parent Read Failure Stops ${mode} Creation`, async () => {
    const { server, cleanup } = await setupMockLinearServer([
      {
        queryName: "GetTeamIdByKey",
        response: {
          data: { teams: { nodes: [{ id: teamWriteIds.ENG }] } },
        },
      },
      {
        queryName: "GetIssueId",
        variables: { id: "ENG-123" },
        response: { data: { issue: { id: "parent-1" } } },
      },
      {
        queryName: "GetParentIssueData",
        variables: { id: "parent-1" },
        response: { errors: [{ message: "Parent project read failed" }] },
      },
    ], { LINEAR_TEAM_ID: "ENG" })
    const terminalStub = stub(
      Object.getPrototypeOf(Deno.stdout),
      "isTerminal",
      () => mode === "interactive",
    )
    const inputStub = stub(Input, "prompt", () => {
      throw new Error("Must stop before prompting")
    })
    const errors: string[] = []
    const errorStub = stub(console, "error", (...args: unknown[]) => {
      errors.push(args.map(String).join(" "))
    })
    const exitStub = stub(Deno, "exit", (code?: number) => {
      assertEquals(code, 1)
      throw new Error("DENO_EXIT")
    })

    try {
      const args = mode === "interactive" ? ["--parent", "ENG-123"] : [
        "--title",
        "Child issue",
        "--team",
        "ENG",
        "--parent",
        "ENG-123",
        "--no-interactive",
      ]
      await assertRejects(() => createCommand.parse(args), Error, "DENO_EXIT")
      assertStringIncludes(errors.join("\n"), "Parent project read failed")
      assertEquals(inputStub.calls.length, 0)
      assertEquals(
        server.graphqlRequests.filter((request) =>
          request.query.includes("mutation")
        ),
        [],
      )
    } finally {
      exitStub.restore()
      errorStub.restore()
      inputStub.restore()
      terminalStub.restore()
      await cleanup()
    }
  })
}

Deno.test("Issue Create Command - Inherits Parent Project When Project Not Set", async () => {
  const { cleanup } = await setupMockLinearServer([
    {
      queryName: "ProjectTeams",
      response: {
        data: {
          project: {
            id: "project-id",
            name: "Project",
            teams: {
              nodes: [{
                id: teamWriteIds.ENG,
                key: "ENG",
                name: "Engineering",
              }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
    },
    {
      queryName: "GetTeamIdByKey",
      variables: { team: "ENG" },
      response: {
        data: {
          teams: {
            nodes: [{ id: teamWriteIds.ENG }],
          },
        },
      },
    },
    {
      queryName: "GetIssueId",
      variables: { id: "ENG-123" },
      response: {
        data: {
          issue: {
            id: "parent-1",
          },
        },
      },
    },
    {
      queryName: "GetParentIssueData",
      variables: { id: "parent-1" },
      response: {
        data: {
          issue: {
            title: "Parent issue",
            identifier: "ENG-123",
            project: {
              id: "project-parent",
            },
          },
        },
      },
    },
    {
      queryName: "CreateIssue",
      variables: {
        input: {
          title: "Child issue",
          parentId: "parent-1",
          labelIds: [],
          teamId: teamWriteIds.ENG,
          projectId: "project-parent",
          useDefaultTemplate: true,
        },
      },
      response: {
        data: {
          issueCreate: {
            success: true,
            issue: {
              id: "child-issue",
              identifier: "ENG-904",
              url: "https://linear.app/test-team/issue/ENG-904/child-issue",
              team: {
                key: "ENG",
              },
            },
          },
        },
      },
    },
  ], { LINEAR_TEAM_ID: "ENG" })

  try {
    await createCommand.parse([
      "--title",
      "Child issue",
      "--team",
      "ENG",
      "--parent",
      "ENG-123",
      "--no-interactive",
    ])
  } finally {
    await cleanup()
  }
})

Deno.test("Issue Create Command - Explicit Project Overrides Parent Project", async () => {
  const { cleanup } = await setupMockLinearServer([
    {
      queryName: "ProjectTeams",
      response: {
        data: {
          project: {
            id: "project-id",
            name: "Project",
            teams: {
              nodes: [{
                id: teamWriteIds.ENG,
                key: "ENG",
                name: "Engineering",
              }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
    },
    {
      queryName: "GetTeamIdByKey",
      variables: { team: "ENG" },
      response: {
        data: {
          teams: {
            nodes: [{ id: teamWriteIds.ENG }],
          },
        },
      },
    },
    {
      queryName: "GetProjectIdByName",
      variables: { name: "Dashboard" },
      response: {
        data: {
          projects: {
            nodes: [{ id: "project-dashboard" }],
          },
        },
      },
    },
    {
      queryName: "GetIssueId",
      variables: { id: "ENG-123" },
      response: {
        data: {
          issue: {
            id: "parent-1",
          },
        },
      },
    },
    {
      queryName: "GetParentIssueData",
      variables: { id: "parent-1" },
      response: {
        data: {
          issue: {
            title: "Parent issue",
            identifier: "ENG-123",
            project: {
              id: "project-parent",
            },
          },
        },
      },
    },
    {
      queryName: "CreateIssue",
      variables: {
        input: {
          title: "Child issue override",
          parentId: "parent-1",
          labelIds: [],
          teamId: teamWriteIds.ENG,
          projectId: "project-dashboard",
          useDefaultTemplate: true,
        },
      },
      response: {
        data: {
          issueCreate: {
            success: true,
            issue: {
              id: "child-issue-override",
              identifier: "ENG-905",
              url:
                "https://linear.app/test-team/issue/ENG-905/child-issue-override",
              team: {
                key: "ENG",
              },
            },
          },
        },
      },
    },
  ], { LINEAR_TEAM_ID: "ENG" })

  try {
    await createCommand.parse([
      "--title",
      "Child issue override",
      "--team",
      "ENG",
      "--parent",
      "ENG-123",
      "--project",
      "Dashboard",
      "--no-interactive",
    ])
  } finally {
    await cleanup()
  }
})

Deno.test("Issue Create Command - Invalid Parent Project Combination Surfaces Backend Error", async () => {
  const { cleanup } = await setupMockLinearServer([
    {
      queryName: "ProjectTeams",
      response: {
        data: {
          project: {
            id: "project-id",
            name: "Project",
            teams: {
              nodes: [{
                id: teamWriteIds.ENG,
                key: "ENG",
                name: "Engineering",
              }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
    },
    {
      queryName: "GetTeamIdByKey",
      variables: { team: "ENG" },
      response: {
        data: {
          teams: {
            nodes: [{ id: teamWriteIds.ENG }],
          },
        },
      },
    },
    {
      queryName: "GetProjectIdByName",
      variables: { name: "Dashboard" },
      response: {
        data: {
          projects: {
            nodes: [{ id: "project-dashboard" }],
          },
        },
      },
    },
    {
      queryName: "GetIssueId",
      variables: { id: "ENG-123" },
      response: {
        data: {
          issue: {
            id: "parent-1",
          },
        },
      },
    },
    {
      queryName: "GetParentIssueData",
      variables: { id: "parent-1" },
      response: {
        data: {
          issue: {
            title: "Parent issue",
            identifier: "ENG-123",
            project: {
              id: "project-parent",
            },
          },
        },
      },
    },
    {
      queryName: "CreateIssue",
      response: {
        errors: [{
          message: "Parent issue and project are incompatible",
        }],
      },
    },
  ], { LINEAR_TEAM_ID: "ENG" })

  const errors: string[] = []
  const errorStub = stub(console, "error", (...args: unknown[]) => {
    errors.push(args.map(String).join(" "))
  })
  const exitStub = stub(Deno, "exit", (_code?: number) => {
    throw new Error("DENO_EXIT")
  })

  try {
    let thrown: Error | undefined
    try {
      await createCommand.parse([
        "--title",
        "Child issue override",
        "--team",
        "ENG",
        "--parent",
        "ENG-123",
        "--project",
        "Dashboard",
        "--no-interactive",
      ])
    } catch (error) {
      thrown = error as Error
    }

    assertEquals(thrown?.message, "DENO_EXIT")
    assertStringIncludes(
      errors.join("\n"),
      "Parent issue and project are incompatible",
    )
  } finally {
    exitStub.restore()
    errorStub.restore()
    await cleanup()
  }
})

Deno.test("Issue Create Command - Config Can Assign Self By Default", async () => {
  const { cleanup } = await setupMockLinearServer([
    {
      queryName: "GetTeamIdByKey",
      variables: { team: "ENG" },
      response: {
        data: {
          teams: {
            nodes: [{ id: teamWriteIds.ENG }],
          },
        },
      },
    },
    {
      queryName: "GetViewerId",
      response: {
        data: {
          viewer: {
            id: "user-self-123",
          },
        },
      },
    },
    {
      queryName: "CreateIssue",
      variables: {
        input: {
          title: "Assigned to self",
          assigneeId: "user-self-123",
          labelIds: [],
          teamId: teamWriteIds.ENG,
          useDefaultTemplate: true,
        },
      },
      response: {
        data: {
          issueCreate: {
            success: true,
            issue: {
              id: "issue-self-default",
              identifier: "ENG-906",
              url:
                "https://linear.app/test-team/issue/ENG-906/assigned-to-self",
              team: {
                key: "ENG",
              },
            },
          },
        },
      },
    },
  ], {
    LINEAR_TEAM_ID: "ENG",
    LINEAR_ISSUE_CREATE_ASSIGN_SELF: "always",
  })

  try {
    await createCommand.parse([
      "--title",
      "Assigned to self",
      "--team",
      "ENG",
      "--no-interactive",
    ])
  } finally {
    await cleanup()
  }
})

Deno.test("Issue Create Command - Auto Assign Mode Respects Linear User Setting In Interactive Create", async () => {
  const { cleanup } = await setupMockLinearServer([
    {
      queryName: "GetUserSettings",
      response: {
        data: {
          userSettings: {
            autoAssignToSelf: true,
          },
        },
      },
    },
    {
      queryName: "GetTeamIdByKey",
      variables: { team: "ENG" },
      response: {
        data: {
          teams: {
            nodes: [{ id: teamWriteIds.ENG }],
          },
        },
      },
    },
    {
      queryName: "GetWorkflowStates",
      variables: { teamKey: teamWriteIds.ENG },
      response: {
        data: {
          team: {
            states: {
              nodes: [],
            },
          },
        },
      },
    },
    {
      queryName: "GetLabelsForTeam",
      response: {
        data: {
          team: {
            labels: {
              nodes: [],
            },
          },
        },
      },
    },
    {
      queryName: "GetViewerId",
      response: {
        data: {
          viewer: {
            id: "user-self-123",
          },
        },
      },
    },
    {
      queryName: "CreateIssue",
      response: {
        data: {
          issueCreate: {
            success: true,
            issue: {
              id: "issue-auto-assign",
              identifier: "ENG-906A",
              url: "https://linear.app/test-team/issue/ENG-906A/auto-assign",
              team: {
                key: "ENG",
              },
            },
          },
        },
      },
    },
  ], { LINEAR_TEAM_ID: "ENG" })

  const stdoutTerminalStub = stub(
    Object.getPrototypeOf(Deno.stdout),
    "isTerminal",
    () => true,
  )
  const stdinTerminalStub = stub(
    Object.getPrototypeOf(Deno.stdin),
    "isTerminal",
    () => true,
  )
  const inputStub = stub(
    Input,
    "prompt",
    (options: string | { message: string }) => {
      const message = typeof options === "string" ? options : options.message
      if (message === "What's the title of your issue?") {
        return Promise.resolve("Auto assign from Linear settings")
      }
      if (message.startsWith("Description")) {
        return Promise.resolve("")
      }
      throw new Error(`Unexpected Input.prompt call: ${message}`)
    },
  )
  const selectStub = stub(Select, "prompt", (options: { message: string }) => {
    if (options.message === "What's next?") {
      return Promise.resolve("submit")
    }
    if (
      options.message ===
        "Start working on this issue now? (creates branch and updates status)"
    ) {
      return Promise.resolve(false)
    }
    throw new Error(`Unexpected Select.prompt call: ${options.message}`)
  })

  try {
    await createCommand.parse([])
  } finally {
    selectStub.restore()
    inputStub.restore()
    stdinTerminalStub.restore()
    stdoutTerminalStub.restore()
    await cleanup()
  }
})

Deno.test("Issue Create Command - Explicit Assignee Overrides Config Self Assignment", async () => {
  const { cleanup } = await setupMockLinearServer([
    {
      queryName: "GetTeamIdByKey",
      variables: { team: "ENG" },
      response: {
        data: {
          teams: {
            nodes: [{ id: teamWriteIds.ENG }],
          },
        },
      },
    },
    {
      queryName: "GetViewerId",
      response: {
        data: {
          viewer: {
            id: "user-self-123",
          },
        },
      },
    },
    {
      queryName: "LookupUser",
      variables: { filter: { email: { eqIgnoreCase: "Jane Developer" } } },
      response: { data: { users: { nodes: [] } } },
    },
    {
      queryName: "LookupUser",
      variables: {
        filter: { displayName: { eqIgnoreCase: "Jane Developer" } },
      },
      response: {
        data: {
          users: {
            nodes: [{
              id: "user-jane-456",
              displayName: "Jane Developer",
              email: "jane@example.com",
              name: "Jane Developer",
            }],
          },
        },
      },
    },
    {
      queryName: "CreateIssue",
      variables: {
        input: {
          title: "Assigned explicitly",
          assigneeId: "user-jane-456",
          labelIds: [],
          teamId: teamWriteIds.ENG,
          useDefaultTemplate: true,
        },
      },
      response: {
        data: {
          issueCreate: {
            success: true,
            issue: {
              id: "issue-explicit-assignee",
              identifier: "ENG-907",
              url:
                "https://linear.app/test-team/issue/ENG-907/assigned-explicitly",
              team: {
                key: "ENG",
              },
            },
          },
        },
      },
    },
  ], {
    LINEAR_TEAM_ID: "ENG",
    LINEAR_ISSUE_CREATE_ASSIGN_SELF: "always",
  })

  try {
    await createCommand.parse([
      "--title",
      "Assigned explicitly",
      "--team",
      "ENG",
      "--assignee",
      "Jane Developer",
      "--no-interactive",
    ])
  } finally {
    await cleanup()
  }
})

Deno.test("Issue Create Command - Interactive Assignee Can Override Config Self Assignment", async () => {
  const { cleanup } = await setupMockLinearServer([
    {
      queryName: "GetTeamIdByKey",
      variables: { team: "ENG" },
      response: {
        data: {
          teams: {
            nodes: [{ id: teamWriteIds.ENG }],
          },
        },
      },
    },
    {
      queryName: "GetWorkflowStates",
      variables: { teamKey: teamWriteIds.ENG },
      response: {
        data: {
          team: {
            states: {
              nodes: [],
            },
          },
        },
      },
    },
    {
      queryName: "GetLabelsForTeam",
      response: {
        data: {
          team: {
            labels: {
              nodes: [],
            },
          },
        },
      },
    },
    {
      queryName: "GetViewerId",
      response: {
        data: {
          viewer: {
            id: "user-self-123",
          },
        },
      },
    },
    {
      queryName: "CreateIssue",
      response: {
        data: {
          issueCreate: {
            success: true,
            issue: {
              id: "issue-interactive-assignee-override",
              identifier: "ENG-908",
              url:
                "https://linear.app/test-team/issue/ENG-908/interactive-assignee-override",
              team: {
                key: "ENG",
              },
            },
          },
        },
      },
    },
  ], {
    LINEAR_TEAM_ID: "ENG",
    LINEAR_ISSUE_CREATE_ASSIGN_SELF: "always",
  })

  const stdoutTerminalStub = stub(
    Object.getPrototypeOf(Deno.stdout),
    "isTerminal",
    () => true,
  )
  const stdinTerminalStub = stub(
    Object.getPrototypeOf(Deno.stdin),
    "isTerminal",
    () => true,
  )
  const inputStub = stub(
    Input,
    "prompt",
    (options: string | { message: string }) => {
      const message = typeof options === "string" ? options : options.message
      if (message === "What's the title of your issue?") {
        return Promise.resolve("Interactive assignee override")
      }
      if (message.startsWith("Description")) {
        return Promise.resolve("")
      }
      throw new Error(`Unexpected Input.prompt call: ${message}`)
    },
  )
  const checkboxStub = stub(
    Checkbox,
    "prompt",
    (options: { message: string }) => {
      if (options.message === "Select additional fields to configure") {
        return Promise.resolve(["assignee"])
      }
      throw new Error(`Unexpected Checkbox.prompt call: ${options.message}`)
    },
  )
  const selectStub = stub(Select, "prompt", (options: { message: string }) => {
    if (options.message === "What's next?") {
      return Promise.resolve("more_fields")
    }
    if (options.message === "Assign this issue to yourself?") {
      return Promise.resolve(false)
    }
    if (
      options.message ===
        "Start working on this issue now? (creates branch and updates status)"
    ) {
      return Promise.resolve(false)
    }
    throw new Error(`Unexpected Select.prompt call: ${options.message}`)
  })

  try {
    await createCommand.parse([])
  } finally {
    selectStub.restore()
    checkboxStub.restore()
    inputStub.restore()
    stdinTerminalStub.restore()
    stdoutTerminalStub.restore()
    await cleanup()
  }
})

// Regression test for #210: an unknown --state must surface the valid options
// and point at `linear team states`, not just "not found".
await snapshotTest({
  name: "Issue Create Command - Unknown State Lists Valid States",
  meta: import.meta,
  colors: false,
  args: [
    "--title",
    "Fix authentication bug",
    "--team",
    "ENG",
    "--state",
    "Nope",
    "--no-interactive",
  ],
  denoArgs: commonDenoArgs,
  canFail: true,
  async fn() {
    const { cleanup } = await setupMockLinearServer([
      {
        queryName: "GetTeamIdByKey",
        variables: { team: "ENG" },
        response: { data: { teams: { nodes: [{ id: teamWriteIds.ENG }] } } },
      },
      {
        queryName: "GetWorkflowStates",
        variables: { teamKey: teamWriteIds.ENG },
        response: {
          data: {
            team: {
              states: {
                nodes: [
                  {
                    id: "s-todo",
                    name: "Todo",
                    type: "unstarted",
                    position: 1,
                  },
                  {
                    id: "s-progress",
                    name: "In Progress",
                    type: "started",
                    position: 2,
                  },
                  {
                    id: "s-done",
                    name: "Done",
                    type: "completed",
                    position: 3,
                  },
                ],
              },
            },
          },
        },
      },
    ], { LINEAR_TEAM_ID: "ENG" })

    try {
      await createCommand.parse()
    } finally {
      await cleanup()
    }
  },
})
