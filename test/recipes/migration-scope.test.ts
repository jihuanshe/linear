import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert"
import { fromFileUrl, join } from "@std/path"

const recipe = fromFileUrl(
  new URL("../../recipes/migrate-team.js", import.meta.url),
)
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
const organization = { id: "workspace", urlKey: "example" }
const source = { id: "source-id", key: "OLD" }
const target = { id: "target-id", key: "NEW" }

async function fixture(lifecycle: "active" | "archived" | "trashed") {
  const directory = await Deno.makeTempDir()
  const migration = join(directory, "migration")
  const binary = join(directory, "linear")
  const script = join(directory, "linear-fixture.js")
  const callsFile = join(directory, "calls.jsonl")
  const bases = [1, 2].map((number) => ({
    organization,
    issue: {
      id: `issue-${number}`,
      identifier: `OLD-${number}`,
      team: source,
      archivedAt: number === 2 && lifecycle === "archived"
        ? "2026-09-01T00:00:00.000Z"
        : null,
      trashed: number === 2 && lifecycle === "trashed",
    },
  }))
  await Deno.writeTextFile(
    script,
    `
const args = Deno.args;
const bases = ${JSON.stringify(bases)};
await Deno.writeTextFile(${
      JSON.stringify(callsFile)
    }, JSON.stringify(args) + '\\n', {append: true});
let result;
if (args[0] === 'api' && args[1].includes('MigrationTeams')) {
  result = {data: {organization: ${
      JSON.stringify(organization)
    }, teams: {nodes: ${JSON.stringify([source, target])}}}};
} else if (args[0] === 'issue' && args[1] === 'query') {
  result = {nodes: bases.map(base => base.issue), pageInfo: {hasNextPage: false, endCursor: null}};
} else if (args[0] === 'issue' && args[1] === 'view') {
  result = bases.find(base => base.issue.id === args[2]);
} else if (args[0] === 'issue' && args[1] === 'update') {
  result = {ok: true, effect: 'applied', data: {issue: {id: args[2], identifier: 'NEW-' + args[2].slice(-1)}}};
} else throw new Error('Unexpected CLI invocation: ' + args);
console.log(JSON.stringify(result));
`,
  )
  await Deno.writeTextFile(
    binary,
    `#!/bin/sh\nexec ${
      quote(Deno.execPath())
    } run --no-config --no-lock --allow-write --deny-net ${
      quote(script)
    } "$@"\n`,
    { mode: 0o755 },
  )
  return {
    migration,
    async run(args: string[], denyWrite?: string) {
      const result = await new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "--no-config",
          "--no-lock",
          "--allow-run",
          "--allow-env=LINEAR_BIN",
          "--allow-read",
          "--allow-write",
          ...(denyWrite ? [`--deny-write=${denyWrite}`] : []),
          "--deny-net",
          recipe,
          ...args,
        ],
        cwd: directory,
        clearEnv: true,
        env: { LINEAR_BIN: binary, NO_COLOR: "1" },
        stdout: "piped",
        stderr: "piped",
      }).output()
      return {
        code: result.code,
        stdout: new TextDecoder().decode(result.stdout),
        stderr: new TextDecoder().decode(result.stderr),
      }
    },
    async calls(): Promise<string[][]> {
      try {
        return (await Deno.readTextFile(callsFile)).trim().split("\n").map(
          (line) => JSON.parse(line),
        )
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) return []
        throw error
      }
    },
    async saveOldScope() {
      await Deno.mkdir(migration)
      for (const [index, base] of bases.entries()) {
        await Deno.writeTextFile(
          join(migration, `${index}.base.json`),
          JSON.stringify(base),
        )
      }
      await Deno.writeTextFile(
        join(migration, "scope.json"),
        JSON.stringify({
          organization,
          source,
          target,
          readAt: "2026-09-01T00:00:00.000Z",
          issues: bases.map((base, index) => ({
            id: base.issue.id,
            identifier: base.issue.identifier,
            baseFile: `${index}.base.json`,
          })),
        }),
      )
    },
    async cleanup() {
      await Deno.remove(directory, { recursive: true })
    },
  }
}

for (const lifecycle of ["archived", "trashed"] as const) {
  Deno.test(`Team freeze rejects an active-first ${lifecycle} scope without executable output`, async () => {
    const f = await fixture(lifecycle)
    try {
      const result = await f.run(["freeze", "OLD", "NEW", f.migration])
      assertEquals(result.code, 1)
      assertStringIncludes(
        result.stderr,
        "Issue issue-2 is archived or trashed",
      )
      assertStringIncludes(result.stderr, "No moves executed")
      const calls = await f.calls()
      assertEquals(calls.find((args) => args[1] === "query"), [
        "issue",
        "query",
        "--team",
        "OLD",
        "--include-archived",
        "--limit",
        "0",
        "--json",
      ])
      assertEquals(
        calls.filter((args) => args[1] === "view").map((args) => args[2]),
        ["issue-1", "issue-2"],
      )
      assertEquals(calls.filter((args) => args[1] === "update"), [])
      await assertRejects(
        () => Deno.stat(join(f.migration, "scope.json")),
        Deno.errors.NotFound,
      )
      await assertRejects(
        () => Deno.stat(join(f.migration, "receipts.jsonl")),
        Deno.errors.NotFound,
      )
    } finally {
      await f.cleanup()
    }
  })

  Deno.test(`Team move rejects saved ${lifecycle} scope before any CLI call or receipt`, async () => {
    const f = await fixture(lifecycle)
    try {
      await f.saveOldScope()
      const result = await f.run(["move", f.migration])
      assertEquals(result.code, 1)
      assertStringIncludes(
        result.stderr,
        "Issue issue-2 is archived or trashed",
      )
      assertEquals(await f.calls(), [])
      await assertRejects(
        () => Deno.stat(join(f.migration, "receipts.jsonl")),
        Deno.errors.NotFound,
      )
    } finally {
      await f.cleanup()
    }
  })
}

Deno.test("Team migration still freezes and moves an active scope with receipts", async () => {
  const f = await fixture("active")
  try {
    const frozen = await f.run(["freeze", "OLD", "NEW", f.migration])
    assertEquals(frozen.code, 0, frozen.stderr)
    assertEquals(
      JSON.parse(frozen.stdout).issues.map((issue: { id: string }) => issue.id),
      ["issue-1", "issue-2"],
    )
    const moved = await f.run(["move", f.migration])
    assertEquals(moved.code, 0, moved.stderr)
    const calls = await f.calls()
    assertEquals(
      calls.filter((args) => args[1] === "update"),
      [1, 2].map((number) => [
        "issue",
        "update",
        `issue-${number}`,
        "--base-file",
        join(f.migration, `${number - 1}.base.json`),
        "--team",
        "target-id",
        "--json",
      ]),
    )
    const receipts =
      (await Deno.readTextFile(join(f.migration, "receipts.jsonl"))).trim()
        .split("\n").map((line) => JSON.parse(line))
    assertEquals(receipts.map((entry) => entry.phase), [
      "dispatch",
      "result",
      "dispatch",
      "result",
    ])
    assertEquals(receipts[1].after, "NEW-1")
    assertEquals(receipts[3].after, "NEW-2")
    assertEquals(receipts[1].result.effect, "applied")
    assertEquals(receipts[3].result.effect, "applied")
    const receiptsBefore = await Deno.readFile(
      join(f.migration, "receipts.jsonl"),
    )
    const repeated = await f.run(["move", f.migration])
    assertEquals(repeated.code, 1)
    for (
      const guidance of [
        "Receipts already exist",
        "no moves executed in this attempt",
        "Preserve receipts and original outputs",
        "reconcile prior effects by stable issue UUID",
        "explicitly select any remaining scope",
        "new directory",
        "Do not delete the ledger",
      ]
    ) assertStringIncludes(repeated.stderr, guidance)
    assertEquals(
      (await f.calls()).slice(calls.length).filter((args) => args[0] !== "api"),
      [],
    )
    assertEquals(
      await Deno.readFile(join(f.migration, "receipts.jsonl")),
      receiptsBefore,
    )
  } finally {
    await f.cleanup()
  }
})

Deno.test("Team move preserves receipt IO errors instead of claiming prior execution", async () => {
  const f = await fixture("active")
  try {
    await f.saveOldScope()
    const receipts = join(f.migration, "receipts.jsonl")
    const result = await f.run(["move", f.migration], receipts)
    assertEquals(result.code, 1)
    assertStringIncludes(result.stderr, "Requires write access")
    assertEquals(result.stderr.includes("Receipts already exist"), false)
    assertEquals((await f.calls()).map((args) => args[0]), ["api"])
    await assertRejects(() => Deno.stat(receipts), Deno.errors.NotFound)
  } finally {
    await f.cleanup()
  }
})
