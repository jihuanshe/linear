import { assertEquals } from "@std/assert"
import { buildSchema, executeSync, parse, validate } from "graphql"
import { guideSources } from "../../../src/guides/content.ts"
import {
  commonDenoArgs,
  setupMockLinearServer,
} from "../../utils/test-helpers.ts"

const emptyConnection = {
  nodes: [],
  pageInfo: { hasNextPage: false, endCursor: null },
}

Deno.test("guide initiative context preserves full bodies through pagination", async () => {
  const query = guideSources.automation.match(
    /linear api '(query ContextInitiatives[^']+)' --paginate/,
  )?.[1]
  if (query == null) throw new Error("ContextInitiatives example missing")
  const schema = buildSchema(await Deno.readTextFile("graphql/schema.graphql"))
  assertEquals(validate(schema, parse(query)).map((error) => error.message), [])
  const nodes = [1, 2].map((n) => ({
    id: `initiative-${n}`,
    name: `name ${n}`,
    url: `https://linear.app/test/initiative/${n}`,
    description: `description ${n}`.repeat(100),
    content: `# Body ${n}\n\n\n- Content\n`.repeat(100),
  }))
  const organization = { id: "workspace", urlKey: "test" }
  const { server, cleanup } = await setupMockLinearServer([{
    queryName: "ContextInitiatives",
    response: ({ query, variables }) => ({
      ...executeSync({
        schema,
        document: parse(query),
        variableValues: variables,
        rootValue: {
          organization,
          initiatives: (args: { after?: string; filter?: unknown }) => {
            assertEquals(args.filter, undefined)
            return {
              nodes: [nodes[args.after == null ? 0 : 1]],
              pageInfo: args.after == null
                ? { hasNextPage: true, endCursor: "next" }
                : { hasNextPage: false, endCursor: null },
            }
          },
        },
      }),
    }),
  }])
  try {
    const result = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        ...commonDenoArgs,
        "src/main.ts",
        "api",
        query,
        "--paginate",
      ],
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output()
    assertEquals(result.code, 0, new TextDecoder().decode(result.stderr))
    assertEquals(JSON.parse(new TextDecoder().decode(result.stdout)), {
      data: {
        organization,
        initiatives: {
          nodes,
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    })
    assertEquals(server.graphqlRequests.length, 2)
    assertEquals(server.graphqlRequests[1].variables.after, "next")
  } finally {
    await cleanup()
  }
})

Deno.test("guide candidate resources preserve identity and unfinished directories without fetching bodies", async () => {
  const query = guideSources.automation.match(
    /linear api '(query ProjectResources[^']+)'/,
  )?.[1]
  if (query == null) throw new Error("ProjectResources example missing")
  const schema = buildSchema(await Deno.readTextFile("graphql/schema.graphql"))
  assertEquals(validate(schema, parse(query)).map((error) => error.message), [])
  const organization = { id: "workspace", urlKey: "test" }
  const project = {
    id: "project-1",
    initiatives: {
      nodes: [{
        id: "initiative",
        name: "Goal",
        url: "https://example.com/goal",
      }],
      pageInfo: { hasNextPage: false, endCursor: "initiative" },
    },
    documents: {
      nodes: [{
        id: "doc-1",
        title: "Routing boundaries",
        url: "https://example.com/document",
        updatedAt: "2026-09-17T00:00:00.000Z",
      }],
      pageInfo: { hasNextPage: true, endCursor: "more-documents" },
    },
    externalLinks: {
      nodes: [{
        id: "link",
        label: "Design",
        url: "https://example.com/design",
      }],
      pageInfo: { hasNextPage: false, endCursor: "link" },
    },
    attachments: emptyConnection,
  }
  const { server, cleanup } = await setupMockLinearServer([{
    queryName: "ProjectResources",
    // Execute the guide selection against the schema, rather than returning
    // fields regardless of whether the example actually requested them.
    response: ({ query, variables }) => ({
      ...executeSync({
        schema,
        document: parse(query),
        variableValues: variables,
        rootValue: {
          organization,
          project: ({ id }: { id: string }) => {
            assertEquals(id, project.id)
            return {
              ...project,
              documents: {
                ...project.documents,
                nodes: project.documents.nodes.map((doc) => ({
                  ...doc,
                  content: () => {
                    throw new Error("Unexpected document body read")
                  },
                })),
              },
            }
          },
        },
      }),
    }),
  }])
  try {
    const result = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        ...commonDenoArgs,
        "src/main.ts",
        "api",
        query,
        "--variables-json",
        '{"id":"project-1"}',
      ],
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output()
    assertEquals(result.code, 0, new TextDecoder().decode(result.stderr))
    assertEquals(JSON.parse(new TextDecoder().decode(result.stdout)), {
      data: { organization, project },
    })
    assertEquals(server.graphqlRequests.length, 1)
  } finally {
    await cleanup()
  }
})

Deno.test("guide resumes a project document directory through its own pagination", async () => {
  const query = guideSources.automation.match(
    /linear api '(query ProjectDocuments[^']+)'/,
  )?.[1]
  if (query == null) throw new Error("ProjectDocuments example missing")
  const schema = buildSchema(await Deno.readTextFile("graphql/schema.graphql"))
  assertEquals(validate(schema, parse(query)).map((error) => error.message), [])
  const organization = { id: "workspace", urlKey: "test" }
  const nodes = [1, 2].map((n) => ({
    id: `doc-${n}`,
    title: `Document ${n}`,
    url: `https://example.com/document/${n}`,
    updatedAt: "2026-09-17T00:00:00.000Z",
  }))
  const { server, cleanup } = await setupMockLinearServer([{
    queryName: "ProjectDocuments",
    response: ({ query, variables }) => ({
      ...executeSync({
        schema,
        document: parse(query),
        variableValues: variables,
        rootValue: {
          organization,
          project: ({ id }: { id: string }) => ({
            id,
            documents: ({ after }: { after?: string }) => ({
              nodes: [nodes[after == null ? 0 : 1]],
              pageInfo: after == null
                ? { hasNextPage: true, endCursor: "doc-next" }
                : { hasNextPage: false, endCursor: null },
            }),
          }),
        },
      }),
    }),
  }])
  try {
    const result = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        ...commonDenoArgs,
        "src/main.ts",
        "api",
        query,
        "--variables-json",
        '{"id":"project-1"}',
        "--paginate",
      ],
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output()
    assertEquals(result.code, 0, new TextDecoder().decode(result.stderr))
    assertEquals(JSON.parse(new TextDecoder().decode(result.stdout)), {
      data: {
        organization,
        project: {
          id: "project-1",
          documents: {
            nodes,
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    })
    assertEquals(server.graphqlRequests.length, 2)
    assertEquals(server.graphqlRequests[1].variables, {
      id: "project-1",
      after: "doc-next",
    })
  } finally {
    await cleanup()
  }
})
