import { assertEquals, assertRejects } from "@std/assert"
import { join } from "@std/path"
import {
  prepareIssueUpdate,
  updateIssueAndVerify,
} from "../../../src/commands/issue/issue-update.ts"
import {
  basis,
  fixture,
  issue,
  manifest,
  OTHER_TEAM,
  PROJECT,
  update,
  USER,
} from "../../delivery/fixture.ts"
import { commonDenoArgs } from "../../utils/test-helpers.ts"

const milestone = { id: "milestone-old", name: "Old milestone" }

Deno.test("issue update --clear-project clears only project and milestone with protected readback", async () => {
  const original = issue(1001, {
    project: PROJECT,
    projectMilestone: milestone,
    assignee: USER,
  })
  const f = await fixture({ issues: [original] })
  try {
    const baseFile = join(f.dir, "original.json")
    await Deno.writeTextFile(baseFile, JSON.stringify(basis(original)))
    const result = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        ...commonDenoArgs,
        "src/main.ts",
        "issue",
        "update",
        original.identifier,
        "--clear-project",
        "--base-file",
        baseFile,
        "--json",
      ],
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output()
    const output = new TextDecoder().decode(result.stdout)
    assertEquals(
      result.code,
      0,
      output + new TextDecoder().decode(result.stderr),
    )
    const body = JSON.parse(output)
    assertEquals(body.effect, "applied")
    assertEquals(body.verification.status, "verified")
    assertEquals(f.mutations().length, 1)
    assertEquals(f.mutations()[0].variables.input, {
      projectId: null,
      projectMilestoneId: null,
    })
    const current = f.state.issues.get(original.id)!
    assertEquals(current.project, null)
    assertEquals(current.projectMilestone, null)
    assertEquals(current.assignee, USER)
    assertEquals(current.state, original.state)
  } finally {
    await f.cleanup()
  }
})

Deno.test("clear-project on an issue without a project is a verified no-op", async () => {
  const original = issue()
  const f = await fixture({ issues: [original] })
  try {
    const result = await updateIssueAndVerify({
      clearProject: true,
      original: basis(original),
    }, original.id)
    assertEquals(result.effect, "none")
    assertEquals(f.mutations(), [])
  } finally {
    await f.cleanup()
  }
})

for (const field of ["project", "projectMilestone"] as const) {
  Deno.test(`clear-project preserves a concurrently changed ${field}`, async () => {
    const original = issue(1001, {
      project: PROJECT,
      projectMilestone: milestone,
    })
    const remote = issue(1001, {
      ...original,
      [field]: { ...original[field], id: "concurrent-id" },
    })
    const f = await fixture({ issues: [remote] })
    try {
      await assertRejects(() =>
        updateIssueAndVerify(
          { clearProject: true, original: basis(original) },
          original.id,
        )
      )
      assertEquals(f.mutations(), [])
      assertEquals(f.state.issues.get(original.id)![field], remote[field])
    } finally {
      await f.cleanup()
    }
  })
}

Deno.test("clear-project rejects missing protection and incompatible options before transport", async () => {
  const f = await fixture()
  try {
    for (
      const options of [
        { clearProject: true },
        { clearProject: true, project: PROJECT.id, unprotected: true },
        { clearProject: true, milestone: "Milestone", unprotected: true },
      ]
    ) {
      await assertRejects(() => prepareIssueUpdate(options, "ENG-1001"))
    }
    assertEquals(f.server.graphqlRequests, [])
  } finally {
    await f.cleanup()
  }
})

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
