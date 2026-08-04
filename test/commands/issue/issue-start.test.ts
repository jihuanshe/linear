import { assertEquals } from "@std/assert"
import { fromFileUrl, join } from "@std/path"
import { stub } from "@std/testing/mock"
import { startCommand } from "../../../src/commands/issue/issue-start.ts"
import { setupMockLinearServer } from "../../utils/test-helpers.ts"

// `issue start` with no issue id lists unstarted issues via the shared
// fetchIssuesForState helper without passing a sort, so it relies on that
// helper defaulting to priority.
Deno.test("Issue Start Command - Does Not Require Sort Config", async () => {
  // Return no issues so the command stops at its empty-list check instead of
  // opening the interactive prompt. Reaching that check confirms the request
  // went out with the default priority sort.
  const { cleanup } = await setupMockLinearServer([
    {
      queryName: "GetIssuesForState",
      variables: {
        sort: [
          { workflowState: { order: "Descending" } },
          { priority: { nulls: "last", order: "Descending" } },
          { manual: { nulls: "last", order: "Ascending" } },
        ],
      },
      response: {
        data: {
          issues: {
            nodes: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    },
  ], { LINEAR_TEAM_ID: "ENG", NO_COLOR: "true" })

  const errorLogs: string[] = []
  const errorStub = stub(console, "error", (...args: unknown[]) => {
    errorLogs.push(args.map(String).join(" "))
  })
  const exitStub = stub(Deno, "exit", (_code?: number): never => {
    throw new Error("EXIT")
  })

  try {
    await startCommand.parse([])
  } catch {
    // expected: handleError calls the stubbed Deno.exit
  } finally {
    errorStub.restore()
    exitStub.restore()
    await cleanup()
  }

  const output = errorLogs.join("\n")
  assertEquals(output.includes("Sort must be provided"), false)
  assertEquals(output.includes("Unstarted issues not found"), true)
})

Deno.test("Issue Start Command - reports partial VCS success when state update fails", async () => {
  const { server, cleanup } = await setupMockLinearServer([
    {
      queryName: "GetIssueDetails",
      variables: { id: "ENG-123" },
      response: {
        data: {
          issue: {
            identifier: "ENG-123",
            title: "Start safely",
            description: null,
            url: "https://linear.app/test/issue/ENG-123/start-safely",
            branchName: "eng-123-test",
            state: null,
            assignee: null,
            priority: 0,
            project: null,
            projectMilestone: null,
            cycle: null,
            team: { activeCycle: null },
            labels: { nodes: [] },
            parent: null,
            children: { nodes: [] },
            inverseRelations: { nodes: [] },
            attachments: { nodes: [] },
            documents: { nodes: [] },
          },
        },
      },
    },
    {
      queryName: "GetWorkflowStates",
      variables: { teamKey: "ENG" },
      response: {
        data: {
          team: {
            states: {
              nodes: [{
                id: "state-started",
                name: "In Progress",
                type: "started",
                position: 1,
              }],
            },
          },
        },
      },
    },
    {
      queryName: "UpdateIssueState",
      variables: { issueId: "ENG-123", stateId: "state-started" },
      response: { data: { issueUpdate: { success: false } } },
    },
  ], { LINEAR_TEAM_ID: "ENG" })
  const tempDir = await Deno.makeTempDir()

  try {
    for (
      const args of [
        ["init"],
        ["config", "user.name", "Linear Test"],
        ["config", "user.email", "linear-test@example.com"],
      ]
    ) {
      const result = await new Deno.Command("git", {
        args,
        cwd: tempDir,
        stdout: "null",
        stderr: "piped",
      }).output()
      assertEquals(result.success, true)
    }
    await Deno.writeTextFile(join(tempDir, "README.md"), "test\n")
    for (const args of [["add", "README.md"], ["commit", "-m", "initial"]]) {
      const result = await new Deno.Command("git", {
        args,
        cwd: tempDir,
        stdout: "null",
        stderr: "piped",
      }).output()
      assertEquals(result.success, true)
    }

    const mainPath = fromFileUrl(
      new URL("../../../src/main.ts", import.meta.url),
    )
    const denoJsonPath = fromFileUrl(
      new URL("../../../deno.json", import.meta.url),
    )
    const denoDir = Deno.env.get("DENO_DIR") ??
      join(Deno.env.get("HOME") ?? tempDir, ".cache", "deno")
    const command = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-all",
        "--quiet",
        `--config=${denoJsonPath}`,
        mainPath,
        "issue",
        "start",
        "ENG-123",
        "--branch",
        "eng-123-test",
      ],
      cwd: tempDir,
      clearEnv: true,
      env: {
        PATH: Deno.env.get("PATH") ?? "",
        HOME: tempDir,
        DENO_DIR: denoDir,
        LINEAR_API_KEY: "Bearer test-token",
        LINEAR_GRAPHQL_ENDPOINT: server.getEndpoint(),
        LINEAR_PROMPT_DISABLED: "1",
        LINEAR_TEAM_ID: "ENG",
        NO_COLOR: "1",
      },
      stdout: "piped",
      stderr: "piped",
    })

    const result = await command.output()
    const stdout = new TextDecoder().decode(result.stdout)
    const stderr = new TextDecoder().decode(result.stderr)
    assertEquals(result.code, 1)
    assertEquals(
      stdout.includes("Created and switched to branch 'eng-123-test'"),
      true,
    )
    assertEquals(
      stderr.includes(
        "VCS work started, but the Linear issue state was not updated",
      ),
      true,
    )

    const branchResult = await new Deno.Command("git", {
      args: ["branch", "--show-current"],
      cwd: tempDir,
      stdout: "piped",
      stderr: "piped",
    }).output()
    assertEquals(
      new TextDecoder().decode(branchResult.stdout).trim(),
      "eng-123-test",
    )
  } finally {
    await Deno.remove(tempDir, { recursive: true })
    await cleanup()
  }
})
