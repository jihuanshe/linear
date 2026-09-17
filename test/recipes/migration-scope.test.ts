import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert"
import { fromFileUrl, join } from "@std/path"
import { loadManifest } from "../../src/delivery/manifest.ts"

const recipe = fromFileUrl(
  new URL("../../recipes/migrate-team.js", import.meta.url),
)
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const organization = { id: uuid(1), urlKey: "example" }
const source = { id: uuid(2), key: "OLD" }
const target = { id: uuid(3), key: "NEW" }

async function fixture(mode = "active") {
  const directory = await Deno.makeTempDir()
  const migration = join(directory, "migration")
  const binary = join(directory, "linear")
  const script = join(directory, "linear-fixture.js")
  const callsFile = join(directory, "calls.jsonl")
  const bases = [11, 12].map((number) => ({
    organization,
    issue: {
      id: uuid(number),
      identifier: `OLD-${number}`,
      team: source,
      archivedAt: number === 12 && mode === "archived"
        ? "2026-09-01T00:00:00Z"
        : null,
      trashed: number === 12 && mode === "trashed",
    },
  }))
  await Deno.writeTextFile(
    script,
    `
const args = Deno.args;
const bases = ${JSON.stringify(bases)};
const mode = ${JSON.stringify(mode)};
await Deno.writeTextFile(${
      JSON.stringify(callsFile)
    }, JSON.stringify(args) + '\\n', {append: true});
let result;
if (args[0] === 'api' && args[1].includes('MigrationTeams')) {
  result = {data: {organization: ${
      JSON.stringify(organization)
    }, teams: {nodes: ${
      JSON.stringify([source, target])
    }, pageInfo: {hasNextPage: false}}}};
} else if (args[0] === 'api' && args[1].includes('MigrationIssues')) {
  let nodes = bases.map(base => ({id: base.issue.id}));
  if (mode === 'duplicate') nodes.push(nodes[0]);
  if (mode === 'empty') nodes = [];
  result = {data: {issues: {nodes, pageInfo: {hasNextPage: mode === 'incomplete'}}}};
} else if (args[0] === 'issue' && args[1] === 'view') {
  result = bases.find(base => base.issue.id === args[2]);
  if (mode === 'read-failure') { console.error('read unavailable'); Deno.exit(1); }
  if (mode === 'workspace-drift') result.organization.id = 'other-workspace';
  if (mode === 'team-drift') result.issue.team.id = 'other-team';
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
    bases,
    async run(args = ["freeze", "OLD", "NEW", migration]) {
      const result = await new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "--no-config",
          "--no-lock",
          "--allow-run",
          "--allow-env=LINEAR_BIN",
          "--allow-read",
          "--allow-write",
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
        return (await Deno.readTextFile(callsFile)).trim().split("\n").map((
          line,
        ) => JSON.parse(line))
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) return []
        throw error
      }
    },
    async cleanup() {
      await Deno.remove(directory, { recursive: true })
    },
  }
}

for (
  const [mode, diagnostic] of [
    ["archived", "archived or trashed"],
    ["trashed", "archived or trashed"],
    ["duplicate", "duplicate issue IDs"],
    ["incomplete", "Incomplete source issue collection"],
    ["workspace-drift", "Issue scope changed"],
    ["team-drift", "Issue scope changed"],
    ["read-failure", "Read failed: read unavailable"],
  ]
) {
  Deno.test(`Team freeze rejects ${mode} without executable output`, async () => {
    const f = await fixture(mode)
    try {
      const result = await f.run()
      assertEquals(result.code, 1)
      assertStringIncludes(result.stderr, diagnostic)
      assertEquals(result.stdout, "")
      const calls = await f.calls()
      const collection = calls.find((args) =>
        args[1].includes("MigrationIssues")
      )!
      assertEquals(collection.includes("--paginate"), true)
      assertStringIncludes(collection[1], "includeArchived: true")
      assertEquals(
        JSON.parse(collection[collection.indexOf("--variables-json") + 1]),
        { team: source.id },
      )
      if (["archived", "trashed"].includes(mode)) {
        assertEquals(
          JSON.parse(await Deno.readTextFile(join(f.migration, "0.base.json"))),
          f.bases[0],
        )
      }
      await assertRejects(
        () => Deno.stat(join(f.migration, "manifest.json")),
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
}

Deno.test("Team freeze writes a loadable v2 UUID manifest with unchanged bases and no executor", async () => {
  const f = await fixture()
  try {
    const result = await f.run()
    assertEquals(result.code, 0, result.stderr)
    const loaded = await loadManifest(join(f.migration, "manifest.json"))
    assertEquals(loaded.manifest, {
      schemaVersion: 2,
      workspace: organization.urlKey,
      issues: [11, 12].map((n, index) => ({
        operation: "update" as const,
        identifier: uuid(n),
        set: { team: target.id },
        baseFile: `${index}.base.json`,
      })),
    })
    assertEquals(JSON.parse(result.stdout), loaded.manifest)
    assertEquals([...loaded.originals.values()], f.bases)
    assertEquals((await f.calls()).map((args) => args[0]), [
      "api",
      "api",
      "issue",
      "issue",
    ])
    assertEquals(
      (await f.calls()).filter((args) => args[0] === "issue").map((args) =>
        args[1]
      ),
      ["view", "view"],
    )
    assertEquals((await f.run()).code, 1)
    assertEquals((await f.calls()).length, 4)
  } finally {
    await f.cleanup()
  }
})

Deno.test("Empty team reports no work instead of an invalid executable manifest", async () => {
  const f = await fixture("empty")
  try {
    const result = await f.run()
    assertEquals(result.code, 0, result.stderr)
    assertStringIncludes(result.stdout, "No work")
    assertEquals(await Array.fromAsync(Deno.readDir(f.migration)), [])
  } finally {
    await f.cleanup()
  }
})

Deno.test("Old migration scope and unknown receipts are never converted or replayed", async () => {
  const f = await fixture()
  try {
    await Deno.mkdir(f.migration)
    const old = {
      "scope.json": '{"issues": ["old scope"]}',
      "receipts.jsonl": '{"effect":"unknown","phase":"dispatch"}\n',
    }
    for (const [name, text] of Object.entries(old)) {
      await Deno.writeTextFile(join(f.migration, name), text)
    }
    assertEquals((await f.run(["move", f.migration])).code, 1)
    assertEquals((await f.run()).code, 1)
    assertEquals(await f.calls(), [])
    for (const [name, text] of Object.entries(old)) {
      assertEquals(await Deno.readTextFile(join(f.migration, name)), text)
    }
    await assertRejects(
      () => Deno.stat(join(f.migration, "manifest.json")),
      Deno.errors.NotFound,
    )
  } finally {
    await f.cleanup()
  }
})
