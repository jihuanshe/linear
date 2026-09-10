import { assertEquals } from "@std/assert"
import { stub } from "@std/testing/mock"
import { fromFileUrl } from "@std/path"
import { deleteCommand } from "../../../src/commands/issue/issue-delete.ts"
import { setupMockLinearServer } from "../../utils/test-helpers.ts"

const main = fromFileUrl(new URL("../../../src/main.ts", import.meta.url))
const issue = {
  id: "11111111-1111-4111-8111-111111111111",
  title: "Moved issue",
  identifier: "TARGET-42",
}
const details = (input = issue.id, entity: typeof issue | null = issue) => ({
  queryName: "GetIssueDeleteDetails",
  variables: { id: input },
  response: { data: { issue: entity } },
})
const removed = (
  id = issue.id,
  payload: unknown = { success: true, entity: issue },
) => ({
  queryName: "DeleteIssue",
  variables: { id },
  response: { data: { issueDelete: payload } },
})
async function runDelete(args: string[]) {
  const result = await new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-all", "--quiet", main, "issue", "delete", ...args],
    stdout: "piped",
    stderr: "piped",
  }).output()
  return {
    code: result.code,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  }
}

Deno.test("Issue Delete Command - Accepts UUID For A Single Issue", async () => {
  const { server, cleanup } = await setupMockLinearServer([
    details(),
    removed(),
  ])
  const logs: string[] = []
  const log = stub(console, "log", (...args: unknown[]) => {
    logs.push(args.join(" "))
  })
  try {
    await deleteCommand.parse([issue.id, "--confirm"])
    assertEquals(logs, ["✓ Successfully deleted issue: TARGET-42: Moved issue"])
    assertEquals(server.graphqlRequests[1].variables, { id: issue.id })
  } finally {
    log.restore()
    await cleanup()
  }
})

Deno.test("Issue Delete Command - Accepts UUID In Bulk Mode", async () => {
  const { cleanup } = await setupMockLinearServer([details(), removed()])
  const logs: string[] = [], errors: string[] = []
  const log = stub(console, "log", (...args: unknown[]) => {
    logs.push(args.join(" "))
  })
  const error = stub(console, "error", (...args: unknown[]) => {
    errors.push(args.join(" "))
  })
  try {
    await deleteCommand.parse(["--confirm", "--bulk", issue.id])
    assertEquals(errors, ["Found 1 issue(s) to delete."])
    assertEquals(logs, ["", "✓ Successfully deleted 1 issue"])
  } finally {
    log.restore()
    error.restore()
    await cleanup()
  }
})

Deno.test("Issue delete resolves an old identifier once and deletes the stable UUID", async () => {
  const { server, cleanup } = await setupMockLinearServer([
    details("OLD-123"),
    removed(),
  ])
  try {
    const result = await runDelete(["OLD-123", "--confirm", "--json"])
    assertEquals(result.code, 0, result.stdout + result.stderr)
    assertEquals(result.stderr, "")
    const output = JSON.parse(result.stdout)
    assertEquals(output.effect, "applied")
    assertEquals(output.data.entity, issue)
    assertEquals(server.graphqlRequests.map((r) => r.variables.id), [
      "OLD-123",
      issue.id,
    ])
  } finally {
    await cleanup()
  }
})

for (
  const [payload, effect] of [[{ success: false }, "unknown"], [{
    success: true,
    entity: null,
  }, "applied"], [
    { success: true, entity: { ...issue, id: "other-id" } },
    "applied",
  ]] as const
) {
  Deno.test(`Issue delete reports ${effect} for ${JSON.stringify(payload)}`, async () => {
    const { server, cleanup } = await setupMockLinearServer([
      details(),
      removed(issue.id, payload),
    ])
    try {
      const result = await runDelete([issue.id, "--confirm", "--json"])
      assertEquals(result.code, 1)
      const output = JSON.parse(result.stdout)
      assertEquals(output.ok, false)
      assertEquals(output.effect, effect)
      assertEquals(output.data.issueDelete, payload)
      assertEquals(
        server.graphqlRequests.filter((r) => r.query.includes("mutation"))
          .length,
        1,
      )
    } finally {
      await cleanup()
    }
  })
}

Deno.test("Bulk issue delete keeps confirmed receipts and stops before later issues on unknown", async () => {
  const second = {
    ...issue,
    id: "22222222-2222-4222-8222-222222222222",
    identifier: "TARGET-43",
  }
  const third = {
    ...issue,
    id: "33333333-3333-4333-8333-333333333333",
    identifier: "TARGET-44",
  }
  const { server, cleanup } = await setupMockLinearServer([
    details(),
    removed(),
    details(second.id, second),
    removed(second.id, { success: false }),
    details(third.id, third),
    removed(third.id, { success: true, entity: third }),
  ])
  try {
    const result = await runDelete([
      "--json",
      "--confirm",
      "--bulk",
      issue.id,
      second.id,
      third.id,
    ])
    assertEquals(result.code, 1)
    assertEquals(result.stderr, "")
    const output = JSON.parse(result.stdout)
    assertEquals(output.effect, "unknown")
    assertEquals(output.data.unattempted, [third.id])
    assertEquals(
      output.data.results.map((
        r: { id: string; effect: string },
      ) => [r.id, r.effect]),
      [[issue.id, "applied"], [second.id, "unknown"]],
    )
    assertEquals(output.data.results[0].data.entity, issue)
    assertEquals(
      server.graphqlRequests.filter((r) => r.query.includes("mutation")).length,
      2,
    )
    assertEquals(
      server.graphqlRequests.some((r) => r.variables.id === third.id),
      false,
    )
  } finally {
    await cleanup()
  }
})

Deno.test("Bulk issue delete does not turn a failed identity lookup into a delete", async () => {
  const { server, cleanup } = await setupMockLinearServer([
    details("MISSING-1", null),
    details(),
    removed(),
  ])
  try {
    const result = await runDelete([
      "--json",
      "--confirm",
      "--bulk",
      "MISSING-1",
      issue.id,
    ])
    assertEquals(result.code, 1)
    const output = JSON.parse(result.stdout)
    assertEquals(output.effect, "applied")
    assertEquals(output.data.results.map((r: { effect: string }) => r.effect), [
      "none",
      "applied",
    ])
    assertEquals(
      server.graphqlRequests.filter((r) => r.query.includes("mutation")).map((
        r,
      ) => r.variables.id),
      [issue.id],
    )
  } finally {
    await cleanup()
  }
})
