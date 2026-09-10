import { assertEquals, assertStringIncludes } from "@std/assert"
import { fromFileUrl } from "@std/path"

const main = fromFileUrl(new URL("../../src/main.ts", import.meta.url))
const id = "11111111-1111-4111-8111-111111111111"
const projectId = "22222222-2222-4222-8222-222222222222"
const linkId = "33333333-3333-4333-8333-333333333333"
const nextId = "44444444-4444-4444-8444-444444444444"
const lastId = "55555555-5555-4555-8555-555555555555"
const finalPage = { hasNextPage: false, endCursor: null }
const { denoDir } = JSON.parse(new TextDecoder().decode(
  (await new Deno.Command(Deno.execPath(), {
    args: ["info", "--json"],
    stdout: "piped",
  }).output()).stdout,
)) as { denoDir: string }

interface RequestBody {
  query: string
  variables: Record<string, unknown>
}

function readResponse(request: RequestBody, archived = false) {
  const target = String(request.variables?.id ?? id)
  const initiative = {
    id: target,
    name: "Example",
    slugId: "example",
    archivedAt: archived ? "2026-09-01T00:00:00Z" : null,
    projects: { nodes: [] },
  }
  return {
    data: {
      initiative,
      initiatives: {
        nodes: [initiative],
        pageInfo: finalPage,
      },
      project: { id: target, name: "Example project" },
      issueLabel: {
        id: target,
        name: "Example label",
        color: "#5E6AD2",
        team: null,
      },
      document: { id: target, title: "Example document", slugId: "example" },
      initiativeToProjects: {
        nodes: [{ id: linkId, initiative: { id }, project: { id: projectId } }],
        pageInfo: finalPage,
      },
    },
  }
}

async function runCli(
  args: string[],
  respond: (request: RequestBody, requests: RequestBody[]) => unknown,
  stdin?: string,
) {
  const root = await Deno.makeTempDir()
  const requests: RequestBody[] = []
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    async (request) => {
      const body = await request.json() as RequestBody
      requests.push(body)
      const result = respond(body, requests)
      return result instanceof Response ? result : Response.json(result)
    },
  )
  try {
    const child = new Deno.Command(Deno.execPath(), {
      args: ["run", "--allow-all", "--quiet", main, ...args, "--json"],
      stdin: stdin === undefined ? "null" : "piped",
      stdout: "piped",
      stderr: "piped",
      clearEnv: true,
      env: {
        HOME: root,
        XDG_CONFIG_HOME: root,
        APPDATA: root,
        DENO_DIR: denoDir,
        NO_COLOR: "1",
        LINEAR_API_KEY: "test-token",
        LINEAR_GRAPHQL_ENDPOINT: `http://127.0.0.1:${server.addr.port}/graphql`,
      },
    }).spawn()
    if (stdin !== undefined) {
      const writer = child.stdin.getWriter()
      await writer.write(new TextEncoder().encode(stdin))
      await writer.close()
    }
    const output = await child.output()
    const stdout = new TextDecoder().decode(output.stdout)
    return {
      code: output.code,
      stdout,
      result: JSON.parse(stdout),
      stderr: new TextDecoder().decode(output.stderr),
      requests,
      mutations: requests.filter((request) =>
        /^mutation\b/.test(request.query.trim())
      ),
    }
  } finally {
    await server.shutdown()
    await Deno.remove(root, { recursive: true })
  }
}

const writes = [
  {
    args: ["label", "create", "--name", "Example"],
    field: "issueLabelCreate",
    entity: "issueLabel",
    object: { id, name: "Example", color: "#5E6AD2", team: null },
    id,
  },
  { args: ["label", "delete", id, "--force"], field: "issueLabelDelete", id },
  {
    args: ["milestone", "create", "--project", projectId, "--name", "Example"],
    field: "projectMilestoneCreate",
    entity: "projectMilestone",
    object: {
      id,
      name: "Example",
      targetDate: null,
      project: { id: projectId, name: "Example" },
    },
    id,
  },
  {
    args: ["milestone", "delete", id, "--force"],
    field: "projectMilestoneDelete",
    id,
  },
  {
    args: ["project", "delete", projectId, "--force"],
    field: "projectDelete",
    entity: "entity",
    object: { id: projectId, name: "Example project" },
    id: projectId,
  },
  {
    args: ["initiative", "create", "--name", "Example"],
    field: "initiativeCreate",
    entity: "initiative",
    object: {
      id,
      name: "Example",
      slugId: "example",
      url: "https://linear.app/example",
    },
    id,
  },
  {
    args: ["initiative", "archive", id, "--force"],
    field: "initiativeArchive",
    id,
  },
  {
    args: ["initiative", "delete", id, "--force"],
    field: "initiativeDelete",
    id,
  },
  {
    args: ["initiative", "unarchive", id, "--force"],
    field: "initiativeUnarchive",
    entity: "entity",
    object: {
      id,
      name: "Example",
      slugId: "example",
      url: "https://linear.app/example",
    },
    id,
  },
  {
    args: ["initiative", "add-project", id, projectId],
    field: "initiativeToProjectCreate",
    entity: "initiativeToProject",
    object: { id: linkId },
    id: linkId,
  },
  {
    args: ["initiative", "remove-project", id, projectId, "--force"],
    field: "initiativeToProjectDelete",
    id: linkId,
  },
  {
    args: ["initiative-update", "create", id, "--body", "A status update"],
    field: "initiativeUpdateCreate",
    entity: "initiativeUpdate",
    object: {
      id,
      body: "A status update",
      health: "onTrack",
      url: "https://linear.app/example",
      initiative: { name: "Example" },
    },
    id,
  },
  {
    args: ["project-update", "create", projectId, "--body", "A status update"],
    field: "projectUpdateCreate",
    entity: "projectUpdate",
    object: {
      id,
      body: "A status update",
      health: "onTrack",
      url: "https://linear.app/example",
      project: { name: "Example" },
    },
    id,
  },
  {
    args: [
      "document",
      "create",
      "--title",
      "Example",
      "--content",
      "Document text",
    ],
    field: "documentCreate",
    entity: "document",
    object: {
      id,
      title: "Example",
      slugId: "example",
      url: "https://linear.app/example",
    },
    id,
  },
  { args: ["document", "delete", id, "--yes"], field: "documentDelete", id },
  {
    args: ["team", "create", "--name", "Example", "--key", "EX"],
    field: "teamCreate",
    entity: "team",
    object: { id, key: "EX", name: "Example" },
    id,
  },
]

for (const write of writes) {
  const name = write.args.slice(0, 2).join(" ")
  for (
    const outcome of [
      "applied",
      "rejected",
      "missing-payload",
      "missing-data",
    ] as const
  ) {
    Deno.test(`write result ${name}: ${outcome}`, async () => {
      const result = await runCli(write.args, (request) => {
        if (!/^mutation\b/.test(request.query.trim())) {
          return readResponse(request, write.args[1] === "unarchive")
        }
        if (outcome === "missing-data") return { data: null }
        const payload = outcome === "missing-payload" ? null : {
          success: outcome === "applied",
          ...(write.entity ? { [write.entity]: write.object } : {}),
        }
        return { data: { [write.field]: payload } }
      })
      assertEquals(
        result.code,
        outcome === "applied" ? 0 : 1,
        result.stdout + result.stderr,
      )
      assertEquals(result.stderr, "")
      assertEquals(result.mutations.length, 1)
      assertEquals(result.result.ok, outcome === "applied")
      assertEquals(
        result.result.effect,
        outcome === "applied" ? "applied" : "unknown",
      )
      if (outcome === "applied") assertEquals(result.result.data.id, write.id)
    })
  }
  if (write.entity) {
    Deno.test(`write result ${name}: success without returned ID retains applied effect`, async () => {
      const result = await runCli(write.args, (request) => {
        if (!/^mutation\b/.test(request.query.trim())) {
          return readResponse(request, write.args[1] === "unarchive")
        }
        return {
          data: { [write.field]: { success: true, [write.entity!]: {} } },
        }
      })
      assertEquals(result.code, 1, result.stdout)
      assertEquals(result.mutations.length, 1)
      assertEquals(result.result.ok, false)
      assertEquals(result.result.effect, "applied")
      assertStringIncludes(result.result.error.message, "object identity")
    })
  }
}

for (
  const args of [
    ["label", "create"],
    ["initiative", "create"],
    ["team", "create"],
    ["document", "create"],
    ["project-update", "create", projectId],
    ["initiative-update", "create", id],
    ["document", "create", "--title", "Example", "--interactive"],
  ]
) {
  Deno.test(`write result ${args.join(" ")}: missing input never writes or prompts`, async () => {
    const result = await runCli(args, (request) => readResponse(request))
    assertEquals(result.code, 1, result.stdout)
    assertEquals(result.result.effect, "none")
    assertEquals(result.mutations, [])
  })
}

for (
  const args of [
    ["label", "delete", id],
    ["milestone", "delete", id],
    ["project", "delete", projectId],
    ["initiative", "archive", id],
    ["initiative", "delete", id],
    ["initiative", "unarchive", id],
    ["initiative", "remove-project", id, projectId],
    ["document", "delete", id],
  ]
) {
  Deno.test(`write result ${args.slice(0, 2).join(" ")}: JSON does not confirm deletion`, async () => {
    const result = await runCli(
      args,
      (request) => readResponse(request, args[1] === "unarchive"),
    )
    assertEquals(result.code, 1, result.stdout)
    assertEquals(result.result.effect, "none")
    assertEquals(result.mutations, [])
    assertStringIncludes(result.result.error.message, "confirmation required")
  })
}

for (
  const [args, field] of [
    [["document", "delete", "--yes"], "documentDelete"],
    [["initiative", "archive", "--force"], "initiativeArchive"],
    [["initiative", "delete", "--force"], "initiativeDelete"],
  ] as const
) {
  Deno.test(`write result ${args.slice(0, 2).join(" ")}: bulk stops unknown and preserves earlier receipt`, async () => {
    const result = await runCli(
      [...args, "--bulk", id, nextId, lastId],
      (request) => {
        if (!/^mutation\b/.test(request.query.trim())) {
          return readResponse(request)
        }
        if (request.variables.id === nextId) {
          return { errors: [{ message: "Execution outcome unavailable" }] }
        }
        return { data: { [field]: { success: true } } }
      },
    )
    assertEquals(result.code, 1, result.stdout)
    assertEquals(result.mutations.map((request) => request.variables.id), [
      id,
      nextId,
    ])
    assertEquals(result.result.effect, "unknown")
    assertEquals(result.result.data.unattempted, [lastId])
    assertEquals(result.result.data.failed, 1)
    assertEquals(result.result.receipts[0].effect, "applied")
    assertEquals(result.result.receipts[0].id, id)
    assertEquals(result.result.receipts[1].effect, "unknown")
  })
}

Deno.test("write result remove-project reads later pages before treating the link as absent", async () => {
  const result = await runCli([
    "initiative",
    "remove-project",
    id,
    projectId,
    "--force",
  ], (request) => {
    if (/^mutation\b/.test(request.query.trim())) {
      return { data: { initiativeToProjectDelete: { success: true } } }
    }
    if (
      request.query.includes("GetInitiativeToProjects") &&
      !request.variables.after
    ) {
      return {
        data: {
          initiativeToProjects: {
            nodes: [],
            pageInfo: { hasNextPage: true, endCursor: "next" },
          },
        },
      }
    }
    return readResponse(request)
  })
  assertEquals(result.code, 0, result.stdout)
  assertEquals(result.result.effect, "applied")
  assertEquals(result.result.data.id, linkId)
  assertEquals(
    result.requests.filter((request) =>
      request.query.includes("GetInitiativeToProjects")
    ).length,
    2,
  )
})

Deno.test("write result add-project does not infer no-op from a duplicate error string", async () => {
  const result = await runCli(
    ["initiative", "add-project", id, projectId],
    (request) => {
      if (/^mutation\b/.test(request.query.trim())) {
        return {
          errors: [{ message: "duplicate or already exists" }],
        }
      }
      return readResponse(request)
    },
  )
  assertEquals(result.code, 1, result.stdout)
  assertEquals(result.result.effect, "unknown")
  assertEquals(result.mutations.length, 1)
})

Deno.test("write result keeps Markdown stdin bytes in a project status update", async () => {
  const body = "A sentence, with spaces.\n\n- two  spaces\n"
  const result = await runCli(
    ["project-update", "create", projectId],
    (request) => {
      if (/^mutation\b/.test(request.query.trim())) {
        return {
          data: {
            projectUpdateCreate: {
              success: true,
              projectUpdate: {
                id,
                body: (request.variables.input as { body: string }).body,
                project: { name: "Example" },
              },
            },
          },
        }
      }
      return readResponse(request)
    },
    body,
  )
  assertEquals(result.code, 0, result.stdout)
  assertEquals(result.result.data.body, body)
  assertEquals(
    (result.mutations[0]?.variables.input as { body: string }).body,
    body,
  )
})

Deno.test("write result label delete fails a UUID read without falling back to a name", async () => {
  const result = await runCli(
    ["label", "delete", id, "--force"],
    () => ({ errors: [{ message: "Read unavailable" }] }),
  )
  assertEquals(result.code, 1)
  assertEquals(result.result.effect, "none")
  assertEquals(result.requests.length, 1)
  assertEquals(result.mutations, [])
})

Deno.test("write result label delete sees ambiguity beyond the first page", async () => {
  const result = await runCli(
    ["label", "delete", "Duplicate", "--force"],
    (request) => ({
      data: {
        issueLabels: {
          nodes: [{
            id: request.variables.after ? nextId : id,
            name: "Duplicate",
            color: "#5E6AD2",
            team: null,
          }],
          pageInfo: request.variables.after
            ? finalPage
            : { hasNextPage: true, endCursor: "next" },
        },
      },
    }),
  )
  assertEquals(result.code, 1)
  assertEquals(result.result.effect, "none")
  assertEquals(result.requests.length, 2)
  assertEquals(result.mutations, [])
  assertStringIncludes(result.result.error.message, "Multiple labels")
})

Deno.test("write result bulk archive reports no effects for already archived initiatives", async () => {
  const result = await runCli([
    "initiative",
    "archive",
    "--force",
    "--bulk",
    id,
    nextId,
  ], (request) => {
    const response = readResponse(request, true)
    return {
      data: {
        ...response.data,
        initiative: {
          ...response.data.initiative,
          archivedAt: "2026-09-01T00:00:00Z",
        },
      },
    }
  })
  assertEquals(result.code, 0, result.stdout)
  assertEquals(result.result.effect, "none")
  assertEquals(
    result.result.data.results.map((item: { effect: string }) => item.effect),
    ["none", "none"],
  )
  assertEquals(result.result.data.unattempted, [])
  assertEquals(result.mutations, [])
})

for (
  const [args, field, expectedId] of [
    [["project", "delete", projectId, "--force"], "projectDelete", projectId],
    [["initiative", "unarchive", id, "--force"], "initiativeUnarchive", id],
  ] as const
) {
  Deno.test(`write result ${args.slice(0, 2).join(" ")}: mismatched receipt retains applied effect`, async () => {
    const result = await runCli([...args], (request) => {
      if (/^mutation\b/.test(request.query.trim())) {
        return { data: { [field]: { success: true, entity: { id: nextId } } } }
      }
      return readResponse(request, args[1] === "unarchive")
    })
    assertEquals(result.code, 1)
    assertEquals(result.result.effect, "applied")
    assertEquals(result.result.data.id, expectedId)
    assertEquals(result.result.data.result.entity.id, nextId)
    assertEquals(result.mutations.length, 1)
  })
}

Deno.test("write result bulk document failure preserves the resolved UUID for reconciliation", async () => {
  const result = await runCli([
    "document",
    "delete",
    "--yes",
    "--bulk",
    "first-slug",
    "second-slug",
    "third-slug",
  ], (request) => {
    if (/^mutation\b/.test(request.query.trim())) {
      if (request.variables.id === nextId) {
        return { errors: [{ message: "Result unavailable" }] }
      }
      return { data: { documentDelete: { success: true } } }
    }
    return {
      data: {
        document: {
          id: request.variables.id === "first-slug" ? id : nextId,
          title: "Example",
        },
      },
    }
  })
  assertEquals(result.code, 1)
  assertEquals(result.result.effect, "unknown")
  assertEquals(result.result.receipts[0].id, id)
  assertEquals(result.result.receipts[1].data.id, nextId)
  assertEquals(result.result.data.unattempted, ["third-slug"])
})
