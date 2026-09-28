import { assertEquals, assertStringIncludes } from "@std/assert"
import { fromFileUrl, join } from "@std/path"
import { setupMockLinearServer } from "../utils/test-helpers.ts"
import type { MockLinearServer } from "../utils/mock_linear_server.ts"

const main = fromFileUrl(new URL("../../src/main.ts", import.meta.url))
const { denoDir } = JSON.parse(new TextDecoder().decode(
  (await new Deno.Command(Deno.execPath(), {
    args: ["info", "--json"],
    stdout: "piped",
  }).output()).stdout,
)) as { denoDir: string }

async function run(server: MockLinearServer, args: string[]) {
  const root = await Deno.makeTempDir()
  try {
    const result = await new Deno.Command(Deno.execPath(), {
      args: ["run", "--allow-all", "--quiet", main, ...args],
      stdout: "piped",
      stderr: "piped",
      stdin: "null",
      clearEnv: true,
      env: {
        HOME: root,
        XDG_CONFIG_HOME: join(root, "config"),
        APPDATA: join(root, "config"),
        DENO_DIR: denoDir,
        PATH: Deno.env.get("PATH") ?? "",
        NO_COLOR: "1",
        LINEAR_API_KEY: "test-token",
        LINEAR_GRAPHQL_ENDPOINT: server.getEndpoint(),
      },
    }).output()
    const decoder = new TextDecoder()
    return {
      code: result.code,
      stdout: decoder.decode(result.stdout),
      stderr: decoder.decode(result.stderr),
    }
  } finally {
    await Deno.remove(root, { recursive: true })
  }
}

const projectId = "11111111-1111-4111-8111-111111111111"
const initiativeId = "22222222-2222-4222-8222-222222222222"
const slugId = "3f2a1b4c5d6e"
const hyphenatedSlugId = "auth-redesign-2024"
const organization = { id: "org-1", urlKey: "acme" }
const connection = (nodes: unknown[]) => ({
  nodes,
  pageInfo: { hasNextPage: false, endCursor: null },
})
const issues = connection([])

function projectServer(
  { urlKey = "acme", found = true, projectSlugId = slugId }: {
    urlKey?: string
    found?: boolean
    projectSlugId?: string
  } = {},
) {
  return setupMockLinearServer([
    {
      queryName: "LookupProjectByUrl",
      variables: { slugId: projectSlugId },
      response: {
        data: {
          organization: { ...organization, urlKey },
          projects: connection(found ? [{ id: projectId }] : []),
        },
      },
    },
    {
      queryName: "GetIssuesForQuery",
      variables: { filter: { project: { id: { eq: projectId } } } },
      response: { data: { issues } },
    },
    {
      queryName: "GetProjectMilestones",
      variables: { projectId },
      response: {
        data: {
          project: {
            id: projectId,
            name: "Checkout",
            projectMilestones: connection([]),
          },
        },
      },
    },
  ])
}

Deno.test("project URL resolves a slug ID containing hyphens through the CLI", async () => {
  const { server, cleanup } = await projectServer({ projectSlugId: hyphenatedSlugId })
  try {
    const result = await run(server, [
      "issue",
      "query",
      "--project",
      `https://linear.app/acme/project/${hyphenatedSlugId}`,
      "--json",
    ])
    assertEquals(result.code, 0, result.stdout + result.stderr)
    assertEquals(JSON.parse(result.stdout), issues)
    assertEquals(
      server.graphqlRequests.map((request) => request.query.match(/query (\w+)/)?.[1]),
      ["LookupProjectByUrl", "GetIssuesForQuery"],
    )
  } finally {
    await cleanup()
  }
})

for (
  const url of [
    `https://linear.app/acme/project/checkout-${slugId}`,
    `https://linear.app/acme/project/checkout-${slugId}/overview`,
    `https://linear.app/acme/project/${slugId}`,
    `https://linear.app/ACME/project/%E8%87%AA%E5%8A%A8%E8%B4%AD%E4%B9%B0-checkout-${slugId}/issues?view=board#top`,
  ]
) {
  Deno.test(`project URL resolves by slug ID in one lookup: ${url}`, async () => {
    const { server, cleanup } = await projectServer()
    try {
      const result = await run(server, [
        "issue",
        "query",
        "--project",
        url,
        "--json",
      ])
      assertEquals(result.code, 0, result.stdout + result.stderr)
      assertEquals(JSON.parse(result.stdout), issues)
      // Same request count as a slug ID: one lookup, then the issue page.
      assertEquals(
        server.graphqlRequests.map((request) =>
          request.query.match(/query (\w+)/)?.[1]
        ),
        ["LookupProjectByUrl", "GetIssuesForQuery"],
      )
    } finally {
      await cleanup()
    }
  })
}

Deno.test("commands that resolve a project to its UUID accept a project URL", async () => {
  const { server, cleanup } = await projectServer()
  try {
    const result = await run(server, [
      "milestone",
      "list",
      "--project",
      `https://linear.app/acme/project/checkout-${slugId}`,
      "--json",
    ])
    assertEquals(result.code, 0, result.stdout + result.stderr)
    assertEquals(JSON.parse(result.stdout), connection([]))
    assertEquals(server.graphqlRequests.length, 2)
  } finally {
    await cleanup()
  }
})

for (
  const { name, options, code, message } of [
    {
      name: "belongs to another workspace",
      options: { urlKey: "other" },
      code: "ValidationError",
      message: "Project URL belongs to a different workspace",
    },
    {
      name: "names no project",
      options: { found: false },
      code: "NotFoundError",
      message:
        `Project not found: https://linear.app/acme/project/checkout-${slugId}`,
    },
  ]
) {
  Deno.test(`project URL fails after its one lookup when it ${name}`, async () => {
    const { server, cleanup } = await projectServer(options)
    try {
      const result = await run(server, [
        "project",
        "teams",
        `https://linear.app/acme/project/checkout-${slugId}`,
        "--json",
      ])
      assertEquals(result.code, 1, result.stdout + result.stderr)
      const failure = JSON.parse(result.stdout)
      assertEquals(failure.error.code, code)
      assertStringIncludes(failure.error.message, message)
      assertEquals(server.graphqlRequests.length, 1)
    } finally {
      await cleanup()
    }
  })
}

Deno.test("initiative URL resolves by slug ID and checks the workspace in one request", async () => {
  const updates = {
    name: "Launch",
    slugId,
    initiativeUpdates: connection([]),
  }
  const { server, cleanup } = await setupMockLinearServer([
    {
      queryName: "FindInitiativeByUrl",
      variables: { slugId },
      response: (request) => ({
        data: {
          organization,
          initiatives: connection(
            request.variables.includeArchived === false
              ? [{ id: initiativeId }]
              : [],
          ),
        },
      }),
    },
    {
      queryName: "ListInitiativeUpdates",
      variables: { id: initiativeId },
      response: { data: { initiative: updates } },
    },
  ])
  try {
    const result = await run(server, [
      "initiative-update",
      "list",
      `https://linear.app/acme/initiative/launch-${slugId}/overview`,
      "--json",
    ])
    assertEquals(result.code, 0, result.stdout + result.stderr)
    assertEquals(JSON.parse(result.stdout), updates)
    assertEquals(server.graphqlRequests.length, 2)

    const other = await run(server, [
      "initiative-update",
      "list",
      `https://linear.app/other/initiative/launch-${slugId}`,
      "--json",
    ])
    assertEquals(other.code, 1, other.stdout + other.stderr)
    assertEquals(
      JSON.parse(other.stdout).error.message.endsWith(
        "Initiative URL belongs to a different workspace",
      ),
      true,
    )
    assertEquals(server.graphqlRequests.length, 3)
  } finally {
    await cleanup()
  }
})
