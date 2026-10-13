import { assertEquals } from "@std/assert"
import {
  fixture,
  issue,
  manifest,
  OTHER_TEAM,
  PROJECT,
  update,
} from "../../delivery/fixture.ts"

const milestone = { id: "milestone-old", name: "Old milestone" }

Deno.test("delivery plans and applies clearProject across teams without retaining the old project's scope", async () => {
  const original = issue(1001, {
    project: PROJECT,
    projectMilestone: milestone,
  })
  const f = await fixture({ issues: [original] })
  try {
    await f.write(
      manifest([update(original, { clearProject: true, team: OTHER_TEAM.id })]),
    )
    const plan = await f.cli("plan")
    assertEquals(plan.success, true, plan.stdout + plan.stderr)
    assertEquals(plan.json().status, "ready")
    assertEquals(f.mutations(), [])
    const result = await f.cli("apply")
    assertEquals(result.success, true, result.stdout + result.stderr)
    assertEquals(result.json().data.status, "completed")
    assertEquals(f.mutations().length, 1)
    assertEquals(f.mutations()[0].variables.input, {
      teamId: OTHER_TEAM.id,
      projectId: null,
      projectMilestoneId: null,
    })
    const repeated = await f.cli("apply")
    assertEquals(repeated.success, true, repeated.stdout + repeated.stderr)
    assertEquals(f.mutations().length, 1)
  } finally {
    await f.cleanup()
  }
})
