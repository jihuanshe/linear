import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert"
import { createIssue } from "../../src/commands/issue/issue-create.ts"
import { updateIssue } from "../../src/commands/issue/issue-update.ts"
import { ValidationError } from "../../src/utils/errors.ts"
import {
  issueWriteBasis,
  issueWriteId,
  setupIssueWriteServer,
  teamWriteIds,
  terminalPage,
} from "../utils/issue-write-fixtures.ts"
import { commonDenoArgs } from "../utils/test-helpers.ts"

const commands = [
  ["issue", "create", "--title", "Priority test", "--team", "ENG"],
  ["issue", "update", "ENG-123", "--unprotected"],
  ["project", "create", "--name", "Priority test", "--team", "ENG"],
]

function runCli(args: string[]) {
  return new Deno.Command(Deno.execPath(), {
    args: ["run", ...commonDenoArgs, "src/main.ts", ...args, "--json"],
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output()
}

function setupPriorityServer(initialPriority = 4) {
  return setupIssueWriteServer([
    {
      queryName: "GetWriteTeamByKey",
      response: {
        data: {
          teams: {
            nodes: [{ id: teamWriteIds.ENG, key: "ENG" }],
            pageInfo: terminalPage,
          },
        },
      },
    },
    {
      queryName: "GetIssueForWrite",
      response: (_request, history) => {
        const basis = issueWriteBasis()
        const update = history.findLast((request) =>
          request.query.includes("mutation UpdateIssue")
        )?.variables.input as { priority: number } | undefined
        basis.issue.priority = update?.priority ?? initialPriority
        return { data: basis }
      },
    },
    ...["CreateIssue", "UpdateIssue", "CreateProject"].map((queryName) => ({
      queryName,
      response: {
        data: {
          [
            queryName === "CreateIssue"
              ? "issueCreate"
              : queryName === "UpdateIssue"
              ? "issueUpdate"
              : "projectCreate"
          ]: {
            success: true,
            [queryName === "CreateProject" ? "project" : "issue"]: {
              id: issueWriteId,
              identifier: "ENG-123",
              title: "Priority test",
              name: "Priority test",
              url: "https://linear.app/test-team/issue/ENG-123",
            },
          },
        },
      },
    })),
  ], { LINEAR_ISSUE_CREATE_ASSIGN_SELF: "never" })
}

for (const command of commands) {
  Deno.test(`${command.slice(0, 2).join(" ")} priority CLI writes numeric values`, async (t) => {
    for (
      const [priority, name] of ["none", "urgent", "high", "medium", "low"]
        .entries()
    ) {
      for (
        const value of [
          String(priority),
          name,
          name.toUpperCase(),
          name[0].toUpperCase() + name.slice(1),
        ]
      ) {
        await t.step(`${value} becomes ${priority}`, async () => {
          const { server, cleanup } = await setupPriorityServer(
            priority === 4 ? 3 : 4,
          )
          try {
            const result = await runCli([...command, "--priority", value])
            const body = JSON.parse(new TextDecoder().decode(result.stdout))
            assertEquals(result.code, 0, JSON.stringify(body))
            assertEquals(body.effect, "applied")
            const writes = server.graphqlRequests.filter((request) =>
              request.query.includes("mutation ")
            )
            assertEquals(writes.length, 1)
            assertEquals(
              (writes[0].variables.input as { priority: number }).priority,
              priority,
            )
            if (command[1] === "update") {
              assertEquals(writes[0].variables, {
                id: issueWriteId,
                input: { priority },
              })
              assertEquals(body.verification.status, "verified")
              assertEquals(body.readBack.issue.priority, priority)
            }
          } finally {
            await cleanup()
          }
        })
      }
    }
  })

  Deno.test(`${command.slice(0, 2).join(" ")} priority CLI rejects invalid values before transport`, async () => {
    const { server, cleanup } = await setupIssueWriteServer([])
    try {
      for (
        const value of [
          "",
          " ",
          "1.5",
          "2.0",
          "-1",
          "5",
          "NaN",
          "Infinity",
          "highest",
        ]
      ) {
        for (
          const priorityArgs of value === ""
            ? [["--priority", ""], ["--priority="]]
            : [["--priority", value]]
        ) {
          const result = await runCli([...command, ...priorityArgs])
          const body = JSON.parse(new TextDecoder().decode(result.stdout))
          assertEquals(result.code, 1, JSON.stringify({ value, body }))
          assertEquals(body.effect, "none")
          assertEquals(body.error.code, "ValidationError")
          assertStringIncludes(body.error.message, "Invalid priority")
          assertEquals(result.stderr.length, 0)
        }
      }
      assertEquals(server.graphqlRequests, [])
    } finally {
      await cleanup()
    }
  })
}

for (const originalPriority of [4, 3]) {
  Deno.test(`issue update named priority preserves original-value comparison: base ${originalPriority}`, async () => {
    const { server, cleanup } = await setupPriorityServer()
    const path = await Deno.makeTempFile({ suffix: ".json" })
    try {
      const original = issueWriteBasis()
      original.issue.priority = originalPriority
      await Deno.writeTextFile(path, JSON.stringify(original))
      const result = await runCli([
        "issue",
        "update",
        "ENG-123",
        "--base-file",
        path,
        "--priority",
        "NoNe",
      ])
      const body = JSON.parse(new TextDecoder().decode(result.stdout))
      assertEquals(
        result.code,
        originalPriority === 4 ? 0 : 1,
        JSON.stringify(body),
      )
      const writes = server.graphqlRequests.filter((request) =>
        request.query.includes("mutation ")
      )
      assertEquals(writes.length, originalPriority === 4 ? 1 : 0)
      if (originalPriority === 4) {
        assertEquals(writes[0].variables, {
          id: issueWriteId,
          input: { priority: 0 },
        })
      } else {
        assertEquals(body.effect, "none")
        assertStringIncludes(
          body.error.message,
          "Original values changed: priority",
        )
      }
    } finally {
      await Deno.remove(path)
      await cleanup()
    }
  })
}

Deno.test("direct Issue operations retain numeric priority validation for delivery", async () => {
  const { server, cleanup } = await setupPriorityServer()
  let writes = 0
  const beforeWrite = () => {
    writes++
    return Promise.resolve()
  }
  try {
    for (const priority of [-1, 5, 1.5, NaN, Infinity, "high", "0", "", null]) {
      // Exercise runtime callers without widening the operation's number contract.
      const options = { priority: priority as number, beforeWrite }
      await assertRejects(
        () => createIssue({ ...options, title: "Priority test", team: "ENG" }),
        ValidationError,
        "Priority must be an integer from 0 to 4",
      )
      await assertRejects(
        () => updateIssue({ ...options, unprotected: true }, "ENG-123"),
        ValidationError,
        "Priority must be an integer from 0 to 4",
      )
    }
    assertEquals(writes, 0)
    assertEquals(server.graphqlRequests, [])

    await createIssue({
      priority: 0,
      title: "Priority test",
      team: "ENG",
      beforeWrite,
    })
    await updateIssue(
      { priority: 0, unprotected: true, beforeWrite },
      "ENG-123",
    )
    assertEquals(writes, 2)
    assertEquals(
      server.graphqlRequests.filter((request) =>
        request.query.includes("mutation ")
      )
        .map((request) =>
          (request.variables.input as { priority: number }).priority
        ),
      [0, 0],
    )
  } finally {
    await cleanup()
  }
})
