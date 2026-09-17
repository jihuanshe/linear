import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert"
import { fromFileUrl, join } from "@std/path"
import { buildSchema, parse, validate } from "graphql"
import { loadManifest } from "../../src/delivery/manifest.ts"
import { loadCheckpoint } from "../../src/delivery/checkpoint.ts"
import {
  connection,
  fixture,
  issue,
  OTHER_TEAM,
  TEAM,
  WORKSPACE,
} from "../delivery/fixture.ts"
import { MockLinearServer } from "../utils/mock_linear_server.ts"

const root = fromFileUrl(new URL("../../", import.meta.url))
const schema = buildSchema(
  await Deno.readTextFile(join(root, "graphql/schema.graphql")),
)
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"

// Run again with LINEAR_RECIPE_TEST_BIN=/absolute/compiled/linear to verify the
// installed artifact. Both paths export through the CLI and run outside checkout.
async function exported(directory: string, name: string, endpoint: string) {
  let binary = Deno.env.get("LINEAR_RECIPE_TEST_BIN")
  if (!binary) {
    binary = join(directory, "linear-bin")
    await Deno.writeTextFile(
      binary,
      `#!/bin/sh\nexec ${quote(Deno.execPath())} run --allow-all --quiet ${
        quote(join(root, "src/main.ts"))
      } "$@"\n`,
      { mode: 0o755 },
    )
  }
  const env = {
    LINEAR_BIN: binary,
    LINEAR_GRAPHQL_ENDPOINT: endpoint,
    LINEAR_API_KEY: "recipe-test-token",
    HOME: directory,
    XDG_CONFIG_HOME: directory,
    NO_COLOR: "1",
  }
  const run = async (command: string, args: string[]) => {
    const result = await new Deno.Command(command, {
      args,
      cwd: directory,
      env,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output()
    return {
      code: result.code,
      stdout: new TextDecoder().decode(result.stdout),
      stderr: new TextDecoder().decode(result.stderr),
    }
  }
  const source = await run(binary, ["recipe", name, "--source"])
  assertEquals(source.code, 0, source.stderr)
  assertEquals(
    source.stdout,
    await Deno.readTextFile(join(root, "recipes", `${name}.js`)),
  )
  const script = join(directory, `${name}.js`)
  await Deno.writeTextFile(script, source.stdout)
  return {
    cli: (args: string[]) => run(binary!, args),
    script: (args: string[]) =>
      run(Deno.execPath(), [
        "run",
        "--no-config",
        "--no-lock",
        "--allow-run",
        "--allow-env",
        "--allow-read",
        "--allow-write",
        script,
        ...args,
      ]),
  }
}

for (const lifecycle of ["archivedAt", "trashed"] as const) {
  Deno.test(`Exported migration uses production plan/apply, stops on ${lifecycle} and resumes by UUID`, async () => {
    const originals = [issue(1001), issue(1002), issue(1003)]
    const f = await fixture({
      issues: originals,
      overrides: (state) => [
        {
          queryName: "MigrationTeams",
          response: ({ query }) => {
            assertEquals(
              validate(schema, parse(query)).map((e) => e.message),
              [],
            )
            return {
              data: {
                organization: WORKSPACE,
                teams: connection([TEAM, OTHER_TEAM]),
              },
            }
          },
        },
        {
          queryName: "MigrationIssues",
          response: ({ query, variables }) => {
            assertEquals(
              validate(schema, parse(query)).map((e) => e.message),
              [],
            )
            assertEquals(variables.team, TEAM.id)
            assertStringIncludes(query, "includeArchived: true")
            return {
              data: {
                issues: variables.after == null
                  ? {
                    nodes: originals.slice(0, 1).map(({ id }) => ({ id })),
                    pageInfo: { hasNextPage: true, endCursor: "page-two" },
                  }
                  : connection(originals.slice(1).map(({ id }) => ({ id }))),
              },
            }
          },
        },
        {
          queryName: "GetIssueDetailsWithComments",
          response: ({ variables }) => ({
            data: {
              organization: WORKSPACE,
              issue: {
                ...state.find(variables.id),
                comments: connection(),
                attachments: connection(),
                children: connection(),
                documents: connection(),
                relations: connection(),
                inverseRelations: connection(),
              },
            },
          }),
        },
        {
          queryName: "UpdateIssue",
          response: ({ variables }) => {
            assertEquals(variables.input, { teamId: OTHER_TEAM.id })
            const value = state.patch(
              state.find(variables.id)!,
              variables.input as Record<string, unknown>,
            )
            value.identifier = `OPS-${
              41 + originals.findIndex((i) => i.id === value.id)
            }`
            return { data: { issueUpdate: { success: true, issue: value } } }
          },
        },
      ],
    })
    try {
      const runner = await exported(
        f.dir,
        "migrate-team",
        f.server.getEndpoint(),
      )
      const migration = join(f.dir, "migration")
      const frozen = await runner.script(["freeze", "ENG", "OPS", migration])
      assertEquals(frozen.code, 0, frozen.stderr)
      const path = join(migration, "manifest.json")
      const loaded = await loadManifest(path)
      assertEquals(loaded.manifest, {
        schemaVersion: 2,
        workspace: WORKSPACE.urlKey,
        issues: originals.map((value, i) => ({
          operation: "update" as const,
          identifier: value.id,
          set: { team: OTHER_TEAM.id },
          baseFile: `${i}.base.json`,
        })),
      })
      assertEquals(
        f.queries("MigrationIssues").map((q) => q.variables.after ?? null),
        [null, "page-two"],
      )
      const saved = await Promise.all(
        originals.map((_, i) =>
          Deno.readTextFile(join(migration, `${i}.base.json`))
        ),
      )
      for (const [i, text] of saved.entries()) {
        const base = JSON.parse(text)
        assertEquals(base.organization, WORKSPACE)
        assertEquals(base.issue.id, originals[i].id)
        assertEquals(base.issue.identifier, originals[i].identifier)
        assertEquals(base.issue.team.id, TEAM.id)
      }
      const plan = await runner.cli(["issue", "plan", "--file", path, "--json"])
      assertEquals(plan.code, 0, plan.stdout + plan.stderr)
      assertEquals(JSON.parse(plan.stdout).status, "ready")
      assertEquals(f.mutations(), [])
      assertEquals(await loadCheckpoint(path), null)

      // The old code now refers to another issue; neither that alias nor a new
      // source-team issue may expand the generated, fixed UUID scope.
      f.state.issues.set(issue(1999).id, issue(1999))
      f.state.aliases.set(originals[0].identifier, issue(1999).id)
      f.state.find(originals[0].id)!.identifier = "ENG-9999"
      const second = f.state.find(originals[1].id)!
      if (lifecycle === "archivedAt") second.archivedAt = "2026-09-01T00:00:00Z"
      else second.trashed = true
      const args = [
        "issue",
        "apply",
        "--file",
        path,
        "--confirm-workspace",
        WORKSPACE.urlKey,
        "--json",
      ]
      const partial = await runner.cli(args)
      assertEquals(partial.code, 1, partial.stdout + partial.stderr)
      const result = JSON.parse(partial.stdout)
      assertEquals(result.effect, "applied")
      assertEquals(
        result.data.items.map((item: { status: string }) => item.status),
        ["applied", "failed", "unattempted"],
      )
      assertEquals(result.data.items[0].receipt, {
        kind: "issue",
        id: originals[0].id,
        identifier: "OPS-41",
      })
      assertEquals(f.mutations().map((q) => q.variables.id), [originals[0].id])
      const checkpoint = await loadCheckpoint(path)
      assertEquals(checkpoint?.workspace, WORKSPACE)
      assertEquals(
        Object.values(checkpoint!.items).map((item) => item.status),
        ["completed", "failed"],
      )

      // The operator resolves lifecycle externally; unchanged originals remain
      // the basis. apply, not this recipe, owns skipping successful writes.
      second.archivedAt = null
      second.trashed = false
      const resumed = await runner.cli(args)
      assertEquals(resumed.code, 0, resumed.stdout + resumed.stderr)
      assertEquals(
        JSON.parse(resumed.stdout).data.items.map((item: { status: string }) =>
          item.status
        ),
        ["skipped", "applied", "applied"],
      )
      assertEquals(
        f.mutations().map((q) => q.variables.id),
        originals.map((i) => i.id),
      )
      assertEquals(f.state.find(issue(1999).id)!.team.id, TEAM.id)
      assertEquals(
        await Promise.all(
          originals.map((_, i) =>
            Deno.readTextFile(join(migration, `${i}.base.json`))
          ),
        ),
        saved,
      )
      await assertRejects(
        () => Deno.stat(join(migration, "receipts.jsonl")),
        Deno.errors.NotFound,
      )
    } finally {
      await f.cleanup()
    }
  })
}

Deno.test("Exported Doctor paginates evidence, limits only human output and fails closed on read errors", async () => {
  const directory = await Deno.makeTempDir()
  const issues = Array.from({ length: 5 }, (_, index) => ({
    id: `doctor-${index}`,
    identifier: `ENG-${index + 1}`,
    title: "Needs priority",
    url: "https://linear.app/testing/issue/ENG-1",
    state: { type: "started", name: "In Progress" },
    priority: 0,
    estimate: 1,
    updatedAt: new Date().toISOString(),
    team: {
      id: TEAM.id,
      key: TEAM.key,
      issueEstimationType: "fibonacci",
      cyclesEnabled: false,
      activeCycle: null,
    },
    cycle: null,
    project: { id: "project-1", name: "Active" },
  }))
  const projects = ["project-1", "project-2"].map((id, index) => ({
    id,
    name: `Project ${index + 1}`,
    createdAt: new Date().toISOString(),
    startedAt: null,
    status: { name: "Started", type: "started" },
    health: index === 0 ? "atRisk" : "onTrack",
    healthUpdatedAt: null,
    lastUpdate: null,
  }))
  issues[4].project = { id: "project-2", name: "Second" }
  let fail = false
  const server = new MockLinearServer([
    {
      queryName: "DoctorViewer",
      response: { data: { viewer: { id: "viewer" } } },
    },
    {
      queryName: "DoctorIssues",
      response: ({ variables }) => {
        assertEquals(variables.includeArchived, true)
        assertEquals(variables.filter, { assignee: { id: { eq: "viewer" } } })
        return variables.after == null
          ? {
            data: {
              issues: {
                nodes: issues.slice(0, 2),
                pageInfo: { hasNextPage: true, endCursor: "issues-2" },
              },
            },
          }
          : fail
          ? { errors: [{ message: "Issue page unavailable" }] }
          : { data: { issues: connection(issues.slice(2)) } }
      },
    },
    {
      queryName: "DoctorProjectTeams",
      response: ({ query, variables }) => {
        assertStringIncludes(query, "includeArchived: true")
        return {
          data: {
            project: {
              teams: variables.after == null
                ? {
                  nodes: [{ key: "OTHER" }],
                  pageInfo: { hasNextPage: true, endCursor: "teams-2" },
                }
                : connection([{ key: TEAM.key }]),
            },
          },
        }
      },
    },
    {
      queryName: "DoctorProjects",
      response: ({ variables }) => ({
        data: {
          projects: variables.after == null
            ? {
              nodes: projects.slice(0, 1),
              pageInfo: { hasNextPage: true, endCursor: "projects-2" },
            }
            : connection(projects.slice(1)),
        },
      }),
    },
  ])
  server.start()
  try {
    const runner = await exported(directory, "doctor", server.getEndpoint())
    const help = await runner.script(["--help"])
    assertEquals(help.code, 0, help.stderr)
    assertStringIncludes(
      help.stdout,
      "deno run --allow-run --allow-env doctor.js",
    )
    assertEquals(help.stdout.includes("recipes/"), false)
    assertEquals(server.graphqlRequests, [])
    const args = [
      "self",
      "--history",
      "--include-archived",
      "--stale-days",
      "30",
      "--limit",
      "1",
    ]
    const json = await runner.script([...args, "--json"])
    assertEquals(json.code, 0, json.stderr)
    const report = JSON.parse(json.stdout)
    assertEquals(report.scanned, { issueCount: 5, projectCount: 2 })
    assertEquals(report.summary, {
      findingCount: 6,
      bySeverity: { P0: 0, P1: 6, P2: 0 },
    })
    assertEquals(report.policy.staleDays, 30)
    assertEquals(report.policy.selectedRules.length, 9)
    assertEquals(
      report.findings.filter((f: { ruleId: string }) =>
        f.ruleId === "project-team-mismatch"
      ),
      [],
    )
    assertEquals(report.findings[0].issue.priority, 0)
    assertEquals(report.findings[0].recommendation.needsHumanDecision, true)
    for (const request of server.graphqlRequests) {
      assertEquals(
        validate(schema, parse(request.query)).map((e) => e.message),
        [],
      )
    }
    assertEquals(
      server.graphqlRequests.filter((q) =>
        q.query.includes("DoctorProjectTeams")
      ).length,
      4,
    )
    const human = await runner.script(args)
    assertEquals(human.code, 0, human.stderr)
    assertStringIncludes(human.stdout, "6 findings (organization policy)")
    assertEquals(human.stdout.match(/^P[012] /gm)?.length, 1)
    const selected = await runner.script([
      ...args,
      "--rule",
      "project-health-risk",
      "--json",
    ])
    assertEquals(selected.code, 0, selected.stderr)
    assertEquals(
      JSON.parse(selected.stdout).findings.map((f: { ruleId: string }) =>
        f.ruleId
      ),
      ["project-health-risk"],
    )
    fail = true
    const failed = await runner.script([...args, "--json"])
    assertEquals(failed.code, 1)
    assertEquals(failed.stdout, "")
    assertStringIncludes(failed.stderr, "no partial report produced")
    assertEquals(
      server.graphqlRequests.some((q) => /\bmutation\b/.test(q.query)),
      false,
    )
  } finally {
    await server.stop()
    await Deno.remove(directory, { recursive: true })
  }
})
