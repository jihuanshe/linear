import { assertEquals, assertRejects } from "@std/assert"
import { fromFileUrl, join } from "@std/path"
import { stub } from "@std/testing/mock"
import { freeze, move } from "../../recipes/migrate-team.js"
import { issueRevset } from "../../recipes/jj-commits.js"

const root = fromFileUrl(new URL("../../", import.meta.url))
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"

async function fixture() {
  const directory = await Deno.makeTempDir()
  const script = join(directory, "fixture.js")
  const binary = join(directory, "linear")
  await Deno.writeTextFile(
    script,
    `
const directory = ${JSON.stringify(directory)};
const args = Deno.args;
await Deno.writeTextFile(directory + '/calls.jsonl', JSON.stringify(args)+'\\n',{append:true});
const organization={id:'workspace',urlKey:'example'};
if(args[0]==='api') {
 if(args[1].includes('MigrationTeams')) console.log(JSON.stringify({data:{organization,teams:{nodes:[{id:'source-id',key:'OLD'},{id:'target-id',key:'NEW'}]}}}));
 else if(args[1].includes('DoctorIssues')) console.log(JSON.stringify({data:{issues:{nodes:[],pageInfo:{hasNextPage:false,endCursor:null}}}}));
 else if(args[1].includes('DoctorProjects')) console.log(JSON.stringify({data:{projects:{nodes:[],pageInfo:{hasNextPage:false,endCursor:null}}}}));
 else throw new Error('Unexpected API');
} else if(args[1]==='query') console.log(JSON.stringify({nodes:[1,2,3].map(n=>({id:'issue-'+n,identifier:'OLD-'+n})),pageInfo:{hasNextPage:false,endCursor:null}}));
else if(args[1]==='view') console.log(JSON.stringify({organization,issue:{id:args[2],identifier:'OLD-'+args[2].slice(-1),team:{id:'source-id',key:'OLD'},state:{id:'todo'}}}));
else if(args[1]==='title') console.log('A title with spaces');
else if(args[1]==='url') console.log('https://linear.app/example/issue/OLD-1');
else if(args[1]==='update') {
 if(args[2]==='issue-1') console.log(JSON.stringify({ok:true,effect:'applied',data:{issue:{id:args[2],identifier:'NEW-42'}}}));
 else { console.log(JSON.stringify({ok:false,effect:'unknown',error:{code:'NETWORK_ERROR'}})); Deno.exit(1); }
} else throw new Error('Unexpected CLI '+args);
`,
  )
  await Deno.writeTextFile(
    binary,
    `#!/bin/sh\nexec ${
      quote(Deno.execPath())
    } run --allow-read --allow-write --allow-env ${quote(script)} "$@"\n`,
    { mode: 0o755 },
  )
  const previous = Deno.env.get("LINEAR_BIN")
  Deno.env.set("LINEAR_BIN", binary)
  return {
    directory,
    binary,
    async calls() {
      return (await Deno.readTextFile(join(directory, "calls.jsonl"))).trim()
        .split("\n").map((s) => JSON.parse(s) as string[])
    },
    async cleanup() {
      if (previous == null) Deno.env.delete("LINEAR_BIN")
      else Deno.env.set("LINEAR_BIN", previous)
      await Deno.remove(directory, { recursive: true })
    },
  }
}

Deno.test("Team migration freezes UUIDs and stops after an unknown result without replay", async () => {
  const f = await fixture()
  const log = stub(console, "log", () => {})
  const err = stub(console, "error", () => {})
  const directory = join(f.directory, "migration")
  try {
    await freeze("OLD", "NEW", directory)
    const scope = JSON.parse(
      await Deno.readTextFile(join(directory, "scope.json")),
    )
    assertEquals(scope.issues.map((i: { id: string }) => i.id), [
      "issue-1",
      "issue-2",
      "issue-3",
    ])
    await assertRejects(
      () => move(directory),
      Error,
      "Stopped at issue-2 (unknown)",
    )
    const updates = (await f.calls()).filter((args) => args[1] === "update")
    assertEquals(updates.map((args) => args[2]), ["issue-1", "issue-2"])
    assertEquals(
      updates.every((args) => args[args.indexOf("--team") + 1] === "target-id"),
      true,
    )
    const receipts =
      (await Deno.readTextFile(join(directory, "receipts.jsonl"))).trim().split(
        "\n",
      ).map((s) => JSON.parse(s))
    assertEquals(receipts[1].before, "OLD-1")
    assertEquals(receipts[1].after, "NEW-42")
    assertEquals(receipts[1].result.effect, "applied")
    assertEquals(receipts[3].result.effect, "unknown")
    await assertRejects(() => move(directory), Deno.errors.AlreadyExists)
    assertEquals(
      (await f.calls()).filter((args) => args[1] === "update").length,
      2,
    )
  } finally {
    log.restore()
    err.restore()
    await f.cleanup()
  }
})

Deno.test("Start recipe preserves the created Git branch when state update is unknown", async () => {
  const f = await fixture()
  try {
    const git = async (args: string[]) =>
      await new Deno.Command("git", {
        args,
        cwd: f.directory,
        stdout: "piped",
        stderr: "piped",
      }).output()
    for (
      const args of [
        ["init", "-b", "main"],
        ["config", "user.name", "Recipe test"],
        ["config", "user.email", "recipe@example.test"],
        ["config", "commit.gpgsign", "false"],
        ["commit", "--allow-empty", "-m", "initial"],
      ]
    ) assertEquals((await git(args)).success, true)
    const args = [
      "run",
      "--allow-run",
      "--allow-env",
      "--allow-read",
      "--allow-write",
      "--config",
      join(root, "deno.json"),
      join(root, "recipes/start-work.js"),
      "git",
      "issue-2",
      "feature/old-2",
      "base.json",
      "In Progress",
    ]
    const first = await new Deno.Command(Deno.execPath(), {
      args,
      cwd: f.directory,
      stdout: "piped",
      stderr: "piped",
    }).output()
    assertEquals(first.code, 1)
    assertEquals(
      new TextDecoder().decode(first.stderr).includes(
        "Local context already exists",
      ),
      true,
    )
    assertEquals(
      new TextDecoder().decode((await git(["branch", "--show-current"])).stdout)
        .trim(),
      "feature/old-2",
    )
    const second = await new Deno.Command(Deno.execPath(), {
      args,
      cwd: f.directory,
      stdout: "piped",
      stderr: "piped",
    }).output()
    assertEquals(second.code, 1)
    assertEquals(
      (await f.calls()).filter((args) => args[1] === "update").length,
      1,
    )
  } finally {
    await f.cleanup()
  }
})

Deno.test("Doctor recipe executable accepts flags and consumes CLI envelopes", async () => {
  const f = await fixture()
  try {
    const result = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-run",
        "--allow-env",
        "--config",
        join(root, "deno.json"),
        join(root, "recipes/doctor.js"),
        "workspace",
        "--json",
        "--history",
        "--include-archived",
        "--rule",
        "missing-project",
      ],
      stdout: "piped",
      stderr: "piped",
    }).output()
    assertEquals(new TextDecoder().decode(result.stderr), "")
    assertEquals(result.code, 0)
    const report = JSON.parse(new TextDecoder().decode(result.stdout))
    assertEquals(report.scope, { kind: "workspace" })
    assertEquals(report.policy.includeHistory, true)
    assertEquals(report.policy.includeArchived, true)
    assertEquals(report.findings, [])
    assertEquals((await f.calls()).length, 1)
    assertEquals((await f.calls())[0].includes("--paginate"), true)
  } finally {
    await f.cleanup()
  }
})

Deno.test("JJ recipe matches complete identifiers within Linear trailers", () => {
  const revset = issueRevset("eng-1")
  const expression = JSON.parse(
    revset.slice("description(regex:".length, -1),
  ) as string
  const regex = new RegExp(expression.replace("(?m)", ""), "m")
  assertEquals(regex.test("Linear-issue: Fixes ENG-1"), true)
  assertEquals(regex.test("Linear-issue: Fixes ENG-10"), false)
  assertEquals(regex.test("Linear-issue: Fixes OTHERENG-1"), false)
  assertEquals(regex.test("Other: ENG-1"), false)
})

Deno.test("Team migration validates every saved basis before its first move", async () => {
  const f = await fixture()
  const log = stub(console, "log", () => {})
  const directory = join(f.directory, "migration")
  try {
    await freeze("OLD", "NEW", directory)
    await Deno.remove(join(directory, "2.base.json"))
    await assertRejects(() => move(directory), Deno.errors.NotFound)
    assertEquals(
      (await f.calls()).filter((args) => args[1] === "update").length,
      0,
    )
    await assertRejects(
      () => Deno.stat(join(directory, "receipts.jsonl")),
      Deno.errors.NotFound,
    )
  } finally {
    log.restore()
    await f.cleanup()
  }
})

Deno.test("GitHub recipes pass explicit repository, body file and native options", async () => {
  const f = await fixture()
  try {
    const mock = join(f.directory, "gh.js")
    await Deno.writeTextFile(mock, "console.log(JSON.stringify(Deno.args))")
    await Deno.writeTextFile(
      join(f.directory, "gh"),
      `#!/bin/sh\nexec ${quote(Deno.execPath())} run ${quote(mock)} "$@"\n`,
      { mode: 0o755 },
    )
    const bodyFile = join(f.directory, "body with spaces.md")
    await Deno.writeTextFile(bodyFile, "Prepared body\n")
    const run = async (script: string, args: string[]) => {
      const result = await new Deno.Command("sh", {
        args: [join(root, "recipes", script), ...args],
        env: { PATH: `${f.directory}:${Deno.env.get("PATH") ?? ""}` },
        stdout: "piped",
        stderr: "piped",
      }).output()
      assertEquals(result.success, true)
      return JSON.parse(new TextDecoder().decode(result.stdout))
    }
    assertEquals(
      await run("create-pr.sh", [
        "OLD-1",
        "owner/repo",
        bodyFile,
        "--draft",
        "--head",
        "feature/old-1",
      ]),
      [
        "pr",
        "create",
        "--repo",
        "owner/repo",
        "--title",
        "OLD-1 A title with spaces",
        "--body-file",
        bodyFile,
        "--draft",
        "--head",
        "feature/old-1",
      ],
    )
    assertEquals(
      await run("github-autolink.sh", ["owner/repo", "ENG", "example"]),
      [
        "api",
        "--method",
        "POST",
        "repos/owner/repo/autolinks",
        "-f",
        "key_prefix=ENG-",
        "-f",
        "url_template=https://linear.app/example/issue/ENG-<num>",
      ],
    )
  } finally {
    await f.cleanup()
  }
})

Deno.test("Guarded edit freezes one basis before discussion and passes it unchanged to the CLI", async () => {
  const f = await fixture()
  const directory = join(f.directory, "edit")
  try {
    const invoke = async (args: string[]) =>
      await new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "--allow-run",
          "--allow-env",
          "--allow-read",
          "--allow-write",
          join(root, "recipes/guarded-edit.js"),
          ...args,
        ],
        stdout: "piped",
        stderr: "piped",
      }).output()
    assertEquals((await invoke(["prepare", "issue-1", directory])).code, 0)
    const original = await Deno.readTextFile(join(directory, "original.json"))
    await Deno.writeTextFile(
      join(directory, "desired.md"),
      "The edited intent\n",
    )
    const submitted = await invoke(["submit", directory])
    assertEquals(submitted.code, 0, new TextDecoder().decode(submitted.stderr))
    assertEquals(
      JSON.parse(new TextDecoder().decode(submitted.stdout)).effect,
      "applied",
    )
    assertEquals(
      await Deno.readTextFile(join(directory, "original.json")),
      original,
    )
    const calls = await f.calls()
    assertEquals(calls.filter((args) => args[1] === "view").length, 1)
    assertEquals(calls.filter((args) => args[1] === "update"), [[
      "issue",
      "update",
      "issue-1",
      "--base-file",
      join(directory, "original.json"),
      "--description-file",
      join(directory, "desired.md"),
      "--json",
    ]])
    assertEquals((await invoke(["prepare", "issue-1", directory])).code, 1)
    assertEquals(
      (await f.calls()).filter((args) => args[1] === "view").length,
      1,
    )
  } finally {
    await f.cleanup()
  }
})
