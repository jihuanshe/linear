import { assertEquals } from "@std/assert"
import {
  fixture,
  issue,
  manifest,
  STATE,
  update,
} from "../../delivery/fixture.ts"

Deno.test("delivery plans and applies clearParent once and repeats as a no-op", async () => {
  const parent = issue(1000)
  const child = issue(1001, {
    parent: {
      id: parent.id,
      identifier: parent.identifier,
      title: parent.title,
      state: STATE,
    },
  })
  const f = await fixture({ issues: [parent, child] })
  try {
    await f.write(manifest([update(child, { clearParent: true })]))
    const plan = await f.cli("plan")
    assertEquals(plan.success, true, plan.stdout + plan.stderr)
    assertEquals(plan.json().status, "ready")
    assertEquals(f.mutations(), [])
    const result = await f.cli("apply")
    assertEquals(result.success, true, result.stdout + result.stderr)
    assertEquals(result.json().data.status, "completed")
    assertEquals(f.mutations().length, 1)
    assertEquals(f.mutations()[0].variables.input, { parentId: null })
    const repeated = await f.cli("apply")
    assertEquals(repeated.success, true, repeated.stdout + repeated.stderr)
    assertEquals(f.mutations().length, 1)
  } finally {
    await f.cleanup()
  }
})
