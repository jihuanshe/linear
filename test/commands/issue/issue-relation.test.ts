import { snapshotTest } from "@cliffy/testing"
import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert"
import { fromFileUrl } from "@std/path"
import {
  addIssueRelation,
  prepareIssueRelation,
  relationCommand,
  type RelationType,
} from "../../../src/commands/issue/issue-relation.ts"
import { WriteError } from "../../../src/utils/errors.ts"
import {
  commonDenoArgs,
  setupMockLinearServer,
} from "../../utils/test-helpers.ts"

const main = fromFileUrl(new URL("../../../src/main.ts", import.meta.url))
const source = {
  id: "11111111-1111-4111-8111-111111111111",
  identifier: "ENG-123",
  title: "Source",
  url: "https://linear.app/test/issue/ENG-123",
}
const target = {
  id: "22222222-2222-4222-8222-222222222222",
  identifier: "ENG-456",
  title: "Target",
  url: "https://linear.app/test/issue/ENG-456",
}
const terminal = { hasNextPage: false, endCursor: null }
const empty = { nodes: [], pageInfo: terminal }
const outgoing = (type = "related") => ({
  id: "relation-existing",
  type,
  relatedIssue: {
    id: target.id,
    identifier: target.identifier,
    title: target.title,
  },
})
const incoming = (type = "related") => ({
  id: "relation-incoming",
  type,
  issue: { id: target.id, identifier: target.identifier, title: target.title },
})
const headers = [source, target].map((issue) => ({
  queryName: "GetIssueHeader",
  variables: { id: issue.identifier },
  response: { data: { issue } },
}))
const inventory = (
  relations: unknown = empty,
  inverseRelations: unknown = empty,
) => ({
  queryName: "GetExistingIssueRelations",
  variables: { issueId: source.id },
  response: { data: { issue: { relations, inverseRelations } } },
})
const created = {
  queryName: "CreateIssueRelation",
  response: {
    data: {
      issueRelationCreate: {
        success: true,
        issueRelation: { id: "relation-created" },
      },
    },
  },
}

async function runRelation(args: string[]) {
  const result = await new Deno.Command(Deno.execPath(), {
    args: ["run", ...commonDenoArgs, main, "issue", "relation", ...args],
    stdout: "piped",
    stderr: "piped",
  }).output()
  const decoder = new TextDecoder()
  return {
    code: result.code,
    stdout: decoder.decode(result.stdout),
    stderr: decoder.decode(result.stderr),
  }
}

await snapshotTest({
  name: "Issue Relation Add Command - Help Text",
  meta: import.meta,
  colors: false,
  args: ["add", "--help"],
  denoArgs: commonDenoArgs,
  async fn() {
    relationCommand.getCommand("add")?.help({ colors: false })
    await relationCommand.parse()
  },
})

for (
  const [type, name] of [["blocks", "Issue Relation Add Command - blocks"], [
    "blocked-by",
    "Issue Relation Add Command - blocked-by shows correct order",
  ]]
) {
  await snapshotTest({
    name,
    meta: import.meta,
    colors: false,
    args: ["add", "ENG-123", type, "ENG-456"],
    denoArgs: commonDenoArgs,
    async fn() {
      const { cleanup } = await setupMockLinearServer([
        ...headers,
        inventory(),
        created,
      ])
      try {
        await relationCommand.parse()
      } finally {
        await cleanup()
      }
    },
  })
}

Deno.test("Issue Relation Add Command - equivalent relation is idempotent", async () => {
  const { server, cleanup } = await setupMockLinearServer([
    ...headers,
    inventory({ nodes: [outgoing()], pageInfo: terminal }),
  ])
  let writes = 0
  try {
    const result = await addIssueRelation(
      source.identifier,
      "related",
      target.identifier,
      {
        beforeWrite: () => {
          writes++
          return Promise.resolve()
        },
      },
    )
    assertEquals(result.effect, "none")
    assertEquals(result.data.relation.id, "relation-existing")
    assertEquals(writes, 0)
    assertEquals(server.graphqlRequests.length, 3)
  } finally {
    await cleanup()
  }
})

Deno.test("Issue Relation Add Command - different relation refuses replacement", async () => {
  const { server, cleanup } = await setupMockLinearServer([
    ...headers,
    inventory({ nodes: [outgoing()], pageInfo: terminal }),
  ])
  let writes = 0
  try {
    await assertRejects(
      () =>
        addIssueRelation(source.identifier, "blocks", target.identifier, {
          beforeWrite: () => {
            writes++
            return Promise.resolve()
          },
        }),
      Error,
      "existing: related ENG-456",
    )
    assertEquals(writes, 0)
    assertEquals(
      server.graphqlRequests.some((r) => r.query.includes("mutation")),
      false,
    )
  } finally {
    await cleanup()
  }
})

for (
  const type of [
    "related",
    "blocks",
    "blocked-by",
    "duplicate",
  ] satisfies RelationType[]
) {
  Deno.test(`Shared relation operation ${type} calls beforeWrite after preparation and sends UUIDs`, async () => {
    const { server, cleanup } = await setupMockLinearServer([
      ...headers,
      inventory(),
      created,
    ])
    let writes = 0
    try {
      const result = await addIssueRelation(
        source.identifier,
        type,
        target.identifier,
        {
          beforeWrite: () => {
            assertEquals(server.graphqlRequests.length, 3)
            writes++
            return Promise.resolve()
          },
        },
      )
      assertEquals(result.effect, "applied")
      assertEquals(result.data.relation.id, "relation-created")
      assertEquals(writes, 1)
      assertEquals(server.graphqlRequests[3].variables, {
        input: {
          issueId: type === "blocked-by" ? target.id : source.id,
          relatedIssueId: type === "blocked-by" ? source.id : target.id,
          type: type === "blocked-by" ? "blocks" : type,
        },
      })
      assertEquals(
        server.graphqlRequests.filter((r) => r.query.includes("GetIssueHeader"))
          .length,
        2,
      )
    } finally {
      await cleanup()
    }
  })
}

Deno.test("Relation preparation completes incoming pages and detects a late conflict", async () => {
  const { server, cleanup } = await setupMockLinearServer([
    ...headers,
    inventory(empty, {
      nodes: [],
      pageInfo: { hasNextPage: true, endCursor: "incoming-next" },
    }),
    {
      queryName: "GetIssueIncomingRelations",
      variables: { issueId: source.id, after: "incoming-next", first: 100 },
      response: {
        data: {
          issue: {
            inverseRelations: {
              nodes: [incoming("blocks")],
              pageInfo: terminal,
            },
          },
        },
      },
    },
  ])
  try {
    await assertRejects(
      () =>
        prepareIssueRelation(source.identifier, "related", target.identifier),
      Error,
      "existing: blocked-by ENG-456",
    )
    assertEquals(server.graphqlRequests.length, 4)
  } finally {
    await cleanup()
  }
})

Deno.test("Relation preparation rejects missing cursors before the write callback", async () => {
  const { server, cleanup } = await setupMockLinearServer([
    ...headers,
    inventory({ nodes: [], pageInfo: { hasNextPage: true, endCursor: null } }),
  ])
  let writes = 0
  try {
    await assertRejects(
      () =>
        addIssueRelation(source.identifier, "blocks", target.identifier, {
          beforeWrite: () => {
            writes++
            return Promise.resolve()
          },
        }),
      Error,
      "empty or repeated cursor",
    )
    assertEquals(writes, 0)
    assertEquals(server.graphqlRequests.length, 3)
  } finally {
    await cleanup()
  }
})

Deno.test("Relation callback failure prevents dispatch", async () => {
  const { server, cleanup } = await setupMockLinearServer([
    ...headers,
    inventory(),
    created,
  ])
  try {
    await assertRejects(
      () =>
        addIssueRelation(source.identifier, "related", target.identifier, {
          beforeWrite: () => {
            throw new Error("Checkpoint write failed")
          },
        }),
      Error,
      "Checkpoint write failed",
    )
    assertEquals(server.graphqlRequests.length, 3)
  } finally {
    await cleanup()
  }
})

for (
  const payload of [{ success: false }, { success: true, issueRelation: null }]
) {
  Deno.test(`Relation effect preserves mutation acknowledgement success=${payload.success}`, async () => {
    const { server, cleanup } = await setupMockLinearServer([
      ...headers,
      inventory(),
      {
        queryName: "CreateIssueRelation",
        response: { data: { issueRelationCreate: payload } },
      },
    ])
    try {
      const error = await assertRejects(
        () => addIssueRelation(source.identifier, "related", target.identifier),
        WriteError,
      )
      assertEquals(error.effect, payload.success ? "applied" : "unknown")
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

Deno.test("Relation JSON uses one result and inverse related deletion uses the existing edge ID", async () => {
  const { server, cleanup } = await setupMockLinearServer([
    ...headers,
    inventory(empty, { nodes: [incoming()], pageInfo: terminal }),
    {
      queryName: "DeleteIssueRelation",
      variables: { id: "relation-incoming" },
      response: { data: { issueRelationDelete: { success: true } } },
    },
  ])
  try {
    const result = await runRelation([
      "delete",
      source.identifier,
      "related",
      target.identifier,
      "--json",
    ])
    assertEquals(result.code, 0, result.stdout + result.stderr)
    assertEquals(result.stderr, "")
    const data = JSON.parse(result.stdout)
    assertEquals(data.effect, "applied")
    assertEquals(data.data.relation.id, "relation-incoming")
    assertEquals(
      server.graphqlRequests.filter((r) => r.query.includes("mutation")).length,
      1,
    )
  } finally {
    await cleanup()
  }
})

Deno.test("Relation JSON no-op has no mutation and list retains complete connections", async () => {
  const { server, cleanup } = await setupMockLinearServer([
    ...headers,
    inventory(empty, { nodes: [incoming()], pageInfo: terminal }),
  ])
  try {
    const add = await runRelation([
      "add",
      source.identifier,
      "related",
      target.identifier,
      "--json",
    ])
    assertEquals(add.code, 0, add.stdout + add.stderr)
    assertEquals(JSON.parse(add.stdout).effect, "none")
    const list = await runRelation(["list", source.identifier, "--json"])
    assertEquals(list.code, 0, list.stdout + list.stderr)
    assertEquals(
      JSON.parse(list.stdout).issue.inverseRelations.pageInfo,
      terminal,
    )
    assertEquals(
      server.graphqlRequests.some((r) => r.query.includes("mutation")),
      false,
    )
    assertStringIncludes(list.stdout, "relation-incoming")
  } finally {
    await cleanup()
  }
})
