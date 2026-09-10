import { assertEquals, assertStringIncludes } from "@std/assert"
import { applyManifest, planManifest } from "../../src/delivery/engine.ts"
import {
  connection,
  create,
  fixture,
  issue,
  manifest,
  OTHER_TEAM,
  PROJECT,
  TEAM,
  update,
} from "./fixture.ts"

for (const operation of ["create", "update"] as const) {
  for (const compatible of [true, false]) {
    Deno.test(`delivery project preflight ${operation}: compatible=${compatible}`, async () => {
      const original = issue()
      const f = await fixture({ issues: [original] })
      try {
        f.state.projects.get(PROJECT.id)!.teams = connection(
          compatible ? [TEAM] : [OTHER_TEAM],
        )
        const entry = operation === "create"
          ? { operation, set: { ...create().set, project: PROJECT.id } }
          : update(original, { project: PROJECT.id })
        const loaded = await f.load(manifest([entry]))
        const plan = await planManifest({ loaded })
        assertEquals(plan.status, compatible ? "ready" : "failed")
        assertEquals(f.mutations().length, 0)
        const result = await applyManifest({
          loaded,
          verificationDelay: () => Promise.resolve(),
        })
        assertEquals(
          result.status,
          compatible ? "completed" : "stopped-on-failure",
        )
        assertEquals(result.summary.unknown, 0)
        assertEquals(f.mutations().length, compatible ? 1 : 0)
        if (!compatible) {
          assertStringIncludes(result.items[0].detail ?? "", "does not belong")
        }
      } finally {
        await f.cleanup()
      }
    })
  }
}

for (
  const mode of [
    "compatible",
    "incompatible",
    "no-project",
    "read-failure",
    "id-failure",
  ] as const
) {
  Deno.test(`delivery inherited parent project is checked before create: ${mode}`, async () => {
    const parent = issue(99, {
      identifier: "OPS-99",
      team: OTHER_TEAM,
      project: mode === "no-project" ? null : PROJECT,
    })
    const f = await fixture({
      issues: [parent],
      overrides: () =>
        mode === "read-failure"
          ? [{
            queryName: "GetParentIssueData",
            response: { errors: [{ message: "Parent unavailable" }] },
          }]
          : mode === "id-failure"
          ? [{ queryName: "GetIssueId", response: { data: { issue: null } } }]
          : [],
    })
    try {
      f.state.projects.get(PROJECT.id)!.teams = connection(
        mode === "compatible" ? [TEAM, OTHER_TEAM] : [OTHER_TEAM],
      )
      const loaded = await f.load(
        manifest([{
          operation: "create",
          set: { title: "Child", team: "ENG", parent: "ops-99" },
        }]),
      )
      assertEquals(loaded.manifest.issues[0].set?.parent, "OPS-99")
      const blocked = mode === "incompatible" || mode === "read-failure" ||
        mode === "id-failure"
      const plan = await planManifest({ loaded })
      assertEquals(plan.status, blocked ? "failed" : "ready")
      assertEquals(f.mutations().length, 0)
      const result = await applyManifest({
        loaded,
        verificationDelay: () => Promise.resolve(),
      })
      assertEquals(result.status, blocked ? "stopped-on-failure" : "completed")
      assertEquals(result.summary.unknown, 0)
      assertEquals(f.mutations().length, blocked ? 0 : 1)
      if (blocked) {
        const resumed = await applyManifest({
          loaded,
          verificationDelay: () => Promise.resolve(),
        })
        assertEquals(resumed.status, "stopped-on-failure")
        assertEquals(f.mutations().length, 0)
      } else {
        const payload = f.mutations()[0].variables.input as Record<
          string,
          unknown
        >
        assertEquals(payload.parentId, parent.id)
        if (mode === "no-project") {
          assertEquals(payload.projectId == null, true)
          assertEquals(f.queries("ProjectTeams").length, 0)
        } else assertEquals(payload.projectId, PROJECT.id)
      }
    } finally {
      await f.cleanup()
    }
  })
}

Deno.test("delivery refuses a truncated project team connection before creation", async () => {
  const f = await fixture({
    overrides: () => [{
      queryName: "ProjectTeams",
      response: {
        data: {
          project: {
            ...PROJECT,
            teams: {
              nodes: [TEAM],
              pageInfo: { hasNextPage: true, endCursor: null },
            },
          },
        },
      },
    }],
  })
  try {
    const loaded = await f.load(
      manifest([{
        operation: "create",
        set: { title: "New", team: "ENG", project: PROJECT.id },
      }]),
    )
    assertEquals((await planManifest({ loaded })).status, "failed")
    assertEquals((await applyManifest({ loaded })).status, "stopped-on-failure")
    assertEquals(f.mutations().length, 0)
  } finally {
    await f.cleanup()
  }
})
