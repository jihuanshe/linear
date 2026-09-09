import { assertEquals } from "@std/assert"
import { applyManifest, planManifest } from "../../src/delivery/engine.ts"
import { fixture, issue, manifest, update } from "./fixture.ts"

for (const reference of ["identifier", "uuid", "alias"] as const) {
  Deno.test(`delivery rejects a self-relation resolved from ${reference} before updating fields`, async () => {
    const original = issue()
    const f = await fixture({ issues: [original] })
    try {
      const alias = "OLD-1001"
      f.state.aliases.set(alias, original.id)
      const related = reference === "identifier"
        ? original.identifier
        : reference === "uuid"
        ? original.id
        : alias
      const loaded = await f.load(manifest([{
        ...update(original),
        relations: [{ type: "related", issue: related }],
      }]))

      const plan = await planManifest({ loaded })
      assertEquals(plan.status, "failed")
      assertEquals(
        plan.issues[0].error?.error.message,
        "An issue cannot be related to itself",
      )
      assertEquals(f.mutations().length, 0)

      const result = await applyManifest({ loaded })
      assertEquals(result.status, "stopped-on-failure")
      assertEquals(result.effect, "none")
      assertEquals(f.mutations().length, 0)
      assertEquals(f.state.find(original.id)?.title, original.title)
      assertEquals(f.state.relations, [])
    } finally {
      await f.cleanup()
    }
  })
}

Deno.test("delivery updates fields and adds a relation to a different Issue", async () => {
  const original = issue(), related = issue(1002)
  const f = await fixture({ issues: [original, related] })
  try {
    const loaded = await f.load(manifest([{
      ...update(original),
      relations: [{ type: "related", issue: related.identifier }],
    }]))
    const plan = await planManifest({ loaded })
    assertEquals(plan.status, "ready")
    assertEquals(plan.issues[0].relations[0].verdict, "add")
    assertEquals(f.mutations().length, 0)

    const result = await applyManifest({ loaded })
    assertEquals(result.status, "completed")
    assertEquals(result.effect, "applied")
    assertEquals(f.state.find(original.id)?.title, "Desired title")
    assertEquals(f.state.relations, [{
      id: "relation-1",
      type: "related",
      issueId: original.id,
      relatedIssueId: related.id,
    }])
    assertEquals(f.mutations().length, 2)
  } finally {
    await f.cleanup()
  }
})
