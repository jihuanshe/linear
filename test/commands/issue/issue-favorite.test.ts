import { assertEquals } from "@std/assert"
import { stub } from "@std/testing/mock"
import { favoriteCommand } from "../../../src/commands/issue/issue-favorite.ts"
import { setupMockLinearServer } from "../../utils/test-helpers.ts"

const issue = {
  id: "11111111-1111-4111-8111-111111111111",
  identifier: "ENG-123",
  title: "Feedback",
  url: "https://linear.app/test/issue/ENG-123",
}
const header = {
  queryName: "GetIssueHeader",
  variables: { id: "ENG-123" },
  response: { data: { issue } },
}
const favorite = {
  id: "favorite-1",
  type: "issue",
  title: "Feedback",
  url: issue.url,
  folderName: null,
  issue: { id: issue.id, identifier: issue.identifier },
}
const favorites = (nodes: unknown[]) => ({
  queryName: "ListFavorites",
  response: {
    data: {
      favorites: { nodes, pageInfo: { hasNextPage: false, endCursor: null } },
    },
  },
})

async function run(args: string[]) {
  const output: string[] = []
  const log = stub(console, "log", (value: string) => output.push(value))
  try {
    await favoriteCommand.parse([...args, "--json"])
  } finally {
    log.restore()
  }
  return JSON.parse(output.join("\n"))
}

function mutations(server: { graphqlRequests: { query: string }[] }) {
  return server.graphqlRequests.filter((request) =>
    request.query.includes("mutation")
  )
}

for (const existing of [false, true]) {
  Deno.test(`favorite add writes only when the issue is not favorited (existing ${existing})`, async () => {
    const { server, cleanup } = await setupMockLinearServer([
      header,
      favorites(existing ? [favorite] : []),
      {
        queryName: "CreateFavorite",
        variables: { input: { issueId: issue.id } },
        response: {
          data: { favoriteCreate: { success: true, favorite } },
        },
      },
    ])
    try {
      const result = await run(["add", "ENG-123"])
      assertEquals(result.effect, existing ? "none" : "applied")
      assertEquals(result.data.favorite.id, "favorite-1")
      assertEquals(mutations(server).length, existing ? 0 : 1)
    } finally {
      await cleanup()
    }
  })

  Deno.test(`favorite remove deletes only an existing favorite (existing ${existing})`, async () => {
    const { server, cleanup } = await setupMockLinearServer([
      header,
      favorites(existing ? [favorite] : []),
      {
        queryName: "DeleteFavorite",
        variables: { id: "favorite-1" },
        response: { data: { favoriteDelete: { success: true } } },
      },
    ])
    try {
      const result = await run(["remove", "ENG-123"])
      assertEquals(result.effect, existing ? "applied" : "none")
      assertEquals(
        result.data.favorite?.id ?? null,
        existing ? "favorite-1" : null,
      )
      assertEquals(mutations(server).length, existing ? 1 : 0)
    } finally {
      await cleanup()
    }
  })
}

Deno.test("favorite list keeps only issue favorites", async () => {
  const { cleanup } = await setupMockLinearServer([
    favorites([
      favorite,
      { ...favorite, id: "favorite-2", type: "project", issue: null },
    ]),
  ])
  try {
    const result = await run(["list"])
    assertEquals(result.nodes, [favorite])
    assertEquals(result.pageInfo, { hasNextPage: false, endCursor: null })
  } finally {
    await cleanup()
  }
})
