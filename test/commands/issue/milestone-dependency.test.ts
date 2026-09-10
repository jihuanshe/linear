import { assertEquals, assertIsError } from "@std/assert"
import {
  updateIssue,
  type UpdateIssueOptions,
} from "../../../src/commands/issue/issue-update.ts"
import { ValidationError } from "../../../src/utils/errors.ts"
import {
  issueWriteBasis,
  issueWriteId,
  terminalPage,
} from "../../utils/issue-write-fixtures.ts"
import { setupMockLinearServer } from "../../utils/test-helpers.ts"

const projectA = "55555555-5555-4555-8555-555555555555"
const projectB = "66666666-6666-4666-8666-666666666666"
const milestoneA = "77777777-7777-4777-8777-777777777777"
const milestoneB = "88888888-8888-4888-8888-888888888888"

async function runUpdate(
  options: Pick<UpdateIssueOptions, "milestone" | "project" | "unprotected"> =
    {},
  lookupProject = projectA,
  finalProject = lookupProject,
) {
  const original = issueWriteBasis()
  original.issue.project = { id: projectA }
  const originalBefore = structuredClone(original)
  let reads = 0
  let beforeWrites = 0
  const { server, cleanup } = await setupMockLinearServer([
    {
      queryName: "GetIssueForWrite",
      response() {
        const current = structuredClone(originalBefore)
        current.issue.project = { id: ++reads === 1 ? projectA : finalProject }
        return { data: current }
      },
    },
    {
      queryName: "GetIssueProjectId",
      response: { data: { issue: { project: { id: lookupProject } } } },
    },
    {
      queryName: "GetProjectMilestonesForLookup",
      response(request) {
        return {
          data: {
            project: {
              projectMilestones: {
                nodes: [{
                  id: request.variables.projectId === projectA
                    ? milestoneA
                    : milestoneB,
                  name: "Release",
                }],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        }
      },
    },
    {
      queryName: "ProjectTeams",
      response(request) {
        return {
          data: {
            project: {
              id: request.variables.id,
              name: "Project",
              teams: { nodes: [original.issue.team], pageInfo: terminalPage },
            },
          },
        }
      },
    },
    {
      queryName: "UpdateIssue",
      response: {
        data: { issueUpdate: { success: true, issue: original.issue } },
      },
    },
  ])
  try {
    let result: Awaited<ReturnType<typeof updateIssue>> | undefined
    let error: unknown
    try {
      result = await updateIssue({
        milestone: "Release",
        ...options,
        ...(options.unprotected ? {} : { original }),
        beforeWrite: () => {
          beforeWrites++
          return Promise.resolve()
        },
      }, "ENG-123")
    } catch (cause) {
      error = cause
    }
    assertEquals(original, originalBefore)
    const requests = server.graphqlRequests.slice()
    return {
      result,
      error,
      reads,
      beforeWrites,
      requests,
      mutations: requests.filter((request) =>
        /^mutation\b/.test(request.query.trim())
      ),
    }
  } finally {
    await cleanup()
  }
}

for (const unprotected of [false, true]) {
  Deno.test(`issue milestone name rejects project drift after lookup (unprotected=${unprotected})`, async () => {
    const result = await runUpdate({ unprotected }, projectA, projectB)
    assertIsError(
      result.error,
      ValidationError,
      "Issue project changed while resolving the milestone",
    )
    assertEquals(result.reads, 2)
    assertEquals(result.beforeWrites, 0)
    assertEquals(result.mutations, [])
  })
}

Deno.test("issue milestone name follows its actual lookup project when the initial read differs", async () => {
  const result = await runUpdate({}, projectB, projectB)
  assertEquals(result.error, undefined)
  assertEquals(result.beforeWrites, 1)
  assertEquals(result.mutations.map((request) => request.variables), [{
    id: issueWriteId,
    input: { projectMilestoneId: milestoneB },
  }])
})

Deno.test("issue milestone name writes when the lookup project remains unchanged", async () => {
  const result = await runUpdate()
  assertEquals(result.error, undefined)
  assertEquals(result.result?.effect, "applied")
  assertEquals(result.beforeWrites, 1)
  assertEquals(result.mutations.map((request) => request.variables), [{
    id: issueWriteId,
    input: { projectMilestoneId: milestoneA },
  }])
})

Deno.test("issue milestone name with an explicit project can move the issue into that project", async () => {
  const result = await runUpdate({ project: projectB }, projectA, projectA)
  assertEquals(result.error, undefined)
  assertEquals(result.beforeWrites, 1)
  assertEquals(result.mutations.map((request) => request.variables), [{
    id: issueWriteId,
    input: { projectId: projectB, projectMilestoneId: milestoneB },
  }])
  assertEquals(
    result.requests.filter((request) =>
      request.query.includes("query GetIssueProjectId")
    ),
    [],
  )
})

Deno.test("issue milestone UUID does not depend on the issue project for name resolution", async () => {
  const result = await runUpdate({ milestone: milestoneB }, projectA, projectB)
  assertEquals(result.error, undefined)
  assertEquals(result.beforeWrites, 1)
  assertEquals(result.mutations.map((request) => request.variables), [{
    id: issueWriteId,
    input: { projectMilestoneId: milestoneB },
  }])
  assertEquals(
    result.requests.filter((request) =>
      request.query.includes("query GetIssueProjectId") ||
      request.query.includes("query GetProjectMilestonesForLookup")
    ),
    [],
  )
})
