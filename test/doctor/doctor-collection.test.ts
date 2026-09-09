import { assertEquals, assertRejects } from "@std/assert"
import { buildSchema, parse, validate } from "graphql"
import { collectDoctorData, doctorRuleIds } from "../../recipes/doctor.js"

const schema = buildSchema(
  await Deno.readTextFile(
    new URL("../../graphql/schema.graphql", import.meta.url),
  ),
)
const policy = {
  includeHistory: false,
  includeArchived: false,
  staleDays: 14,
  selectedRules: doctorRuleIds,
}
const issue = {
  id: "i",
  identifier: "ENG-1",
  state: { type: "started", name: "In Progress" },
  project: { id: "p", name: "Project" },
}
const project = { id: "p", name: "Project", slugId: "project-slug" }

for (const scope of ["self", "team", "project", "workspace"]) {
  Deno.test(`Doctor recipe collects ${scope} with complete CLI reads and valid GraphQL`, async () => {
    const calls: Array<
      { query: string; vars: Record<string, unknown>; paginate: boolean }
    > = []
    const api = (
      query: string,
      vars: Record<string, unknown> = {},
      paginate = false,
    ) => {
      assertEquals(validate(schema, parse(query)).map((e) => e.message), [])
      calls.push({ query, vars, paginate })
      if (query.includes("DoctorViewer")) {
        return Promise.resolve({ viewer: { id: "user" } })
      }
      if (query.includes("DoctorTeam(")) {
        return Promise.resolve({
          teams: { nodes: [{ id: "team", key: "ENG" }] },
        })
      }
      if (query.includes("DoctorProjectTarget")) {
        return Promise.resolve({ projects: { nodes: [project] } })
      }
      if (query.includes("DoctorProjectTeams")) {
        return Promise.resolve({
          project: {
            teams: {
              nodes: [{ key: "ENG" }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        })
      }
      if (query.includes("DoctorIssues")) {
        return Promise.resolve({ issues: { nodes: [structuredClone(issue)] } })
      }
      return Promise.resolve({ projects: { nodes: [project] } })
    }
    const result = await collectDoctorData(
      scope,
      scope === "team" ? "eng" : scope === "project" ? "Project" : undefined,
      policy,
      api,
    )
    assertEquals(result.projects, [project])
    assertEquals(result.issues[0].project.teams.nodes, [{ key: "ENG" }])
    for (
      const call of calls.filter((c) =>
        /Doctor(Issues|Projects|ProjectTarget|ProjectTeams)/.test(c.query)
      )
    ) assertEquals(call.paginate, true)
    const issueCall = calls.find((c) => c.query.includes("DoctorIssues"))!
    const expected = {
      state: { type: { in: ["started", "unstarted"] } },
      ...(scope === "self"
        ? { assignee: { id: { eq: "user" } } }
        : scope === "team"
        ? { team: { id: { eq: "team" } } }
        : scope === "project"
        ? { project: { id: { eq: "p" } } }
        : {}),
    }
    assertEquals(issueCall.vars.filter, expected)
    assertEquals(issueCall.vars.includeArchived, false)
    assertEquals(
      calls.find((c) => c.query.includes("DoctorProjectTeams"))!.query.includes(
        "includeArchived: true",
      ),
      true,
    )
  })
}

Deno.test("Doctor recipe history and archive are independent; Merged is historical", async () => {
  const calls: Array<Record<string, unknown>> = []
  const api = (query: string, vars: Record<string, unknown> = {}) => {
    calls.push(vars)
    return Promise.resolve(
      query.includes("DoctorIssues")
        ? {
          issues: {
            nodes: [{ ...issue, state: { type: "started", name: "Merged" } }],
          },
        }
        : { projects: { nodes: [] } },
    )
  }
  const selectedRules = ["missing-project"]
  const current = await collectDoctorData("workspace", undefined, {
    ...policy,
    selectedRules,
  }, api)
  const history = await collectDoctorData("workspace", undefined, {
    ...policy,
    includeHistory: true,
    includeArchived: true,
    selectedRules,
  }, api)
  assertEquals(current.issues.length, 0)
  assertEquals(history.issues.length, 1)
  assertEquals(calls[1], { filter: {}, includeArchived: true })
})

Deno.test("Doctor recipe rejects ambiguous project names before scans", async () => {
  let calls = 0
  await assertRejects(
    () =>
      collectDoctorData("project", "Project", policy, () => {
        calls++
        return Promise.resolve({
          projects: { nodes: [project, { ...project, id: "other" }] },
        })
      }),
    Error,
    "ambiguous",
  )
  assertEquals(calls, 1)
})

Deno.test("Doctor recipe project-only rules preserve self and history filters", async () => {
  const calls: string[] = []
  await collectDoctorData("self", undefined, {
    ...policy,
    selectedRules: ["missing-project-update"],
  }, (query: string, vars: Record<string, unknown> = {}) => {
    calls.push(query)
    if (query.includes("DoctorViewer")) {
      return Promise.resolve({ viewer: { id: "user" } })
    }
    assertEquals(vars.filter, {
      status: { type: { in: ["started", "planned"] } },
      issues: {
        some: {
          state: { type: { in: ["started", "unstarted"] } },
          assignee: { id: { eq: "user" } },
        },
      },
    })
    return Promise.resolve({ projects: { nodes: [] } })
  })
  assertEquals(calls.length, 2)
})
