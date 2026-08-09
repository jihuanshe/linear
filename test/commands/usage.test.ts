import { Command } from "@cliffy/command"
import {
  assertEquals,
  assertExists,
  assertMatch,
  assertStringIncludes,
} from "@std/assert"
import { fromFileUrl } from "@std/path"
import { assertSnapshot } from "@std/testing/snapshot"
import { cli } from "../../src/cli.ts"
import {
  buildUsageDocument,
  type UsageDocument,
} from "../../src/commands/usage.ts"

const main = fromFileUrl(new URL("../../src/main.ts", import.meta.url))

const CANONICAL_WRITES_COMMAND_PATHS = [
  "linear api",
  "linear auth default",
  "linear auth login",
  "linear auth logout",
  "linear auth migrate",
  "linear config",
  "linear document create",
  "linear document delete",
  "linear document update",
  "linear initiative add-project",
  "linear initiative archive",
  "linear initiative create",
  "linear initiative delete",
  "linear initiative remove-project",
  "linear initiative unarchive",
  "linear initiative update",
  "linear initiative-update create",
  "linear issue apply",
  "linear issue attach",
  "linear issue comment add",
  "linear issue comment delete",
  "linear issue comment update",
  "linear issue create",
  "linear issue delete",
  "linear issue link",
  "linear issue pull-request",
  "linear issue relation add",
  "linear issue relation delete",
  "linear issue start",
  "linear issue update",
  "linear issue view",
  "linear label create",
  "linear label delete",
  "linear milestone create",
  "linear milestone delete",
  "linear milestone update",
  "linear project create",
  "linear project delete",
  "linear project update",
  "linear project-update create",
  "linear team autolinks",
  "linear team create",
  "linear team delete",
  "linear update",
  "linear upload",
]

async function run(args: string[]) {
  const root = await Deno.makeTempDir()
  try {
    const result = await new Deno.Command(Deno.execPath(), {
      args: ["run", "--allow-all", "--quiet", main, ...args],
      stdout: "piped",
      stderr: "piped",
      clearEnv: true,
      env: {
        HOME: root,
        XDG_CONFIG_HOME: root,
        NO_COLOR: "1",
      },
    }).output()
    const decoder = new TextDecoder()
    return {
      code: result.code,
      stdout: decoder.decode(result.stdout),
      stderr: decoder.decode(result.stderr),
    }
  } finally {
    await Deno.remove(root, { recursive: true })
  }
}

Deno.test("usage provides a concise top-level overview", async () => {
  const result = await run(["usage"])

  assertEquals(result.code, 0, result.stderr)
  assertEquals(result.stderr, "")
  assertStringIncludes(result.stdout, "linear — Handy linear commands")
  assertStringIncludes(result.stdout, "issue, i")
  assertStringIncludes(result.stdout, "[writes; json]")
  assertStringIncludes(result.stdout, "detail: linear <domain> usage")
  assertStringIncludes(result.stdout, "machine-readable: linear usage --json")
})

Deno.test("zero-argument root reuses concise usage navigation", async (t) => {
  const [result, explicitUsage] = await Promise.all([
    run([]),
    run(["usage"]),
  ])

  assertEquals(result.code, 0, result.stderr)
  assertEquals(result.stderr, "")
  assertEquals(result.stdout, explicitUsage.stdout)
  assertEquals(
    new TextEncoder().encode(result.stdout).byteLength <= 2_000,
    true,
  )
  await assertSnapshot(t, result.stdout)
})

Deno.test("zero-argument domain reuses its usage navigation", async () => {
  const [result, aliasResult, explicitUsage] = await Promise.all([
    run(["issue"]),
    run(["i"]),
    run(["issue", "usage"]),
  ])

  assertEquals(result.code, 0, result.stderr)
  assertEquals(result.stderr, "")
  assertEquals(result.stdout, explicitUsage.stdout)
  assertEquals(aliasResult.code, 0, aliasResult.stderr)
  assertEquals(aliasResult.stderr, "")
  assertEquals(aliasResult.stdout, explicitUsage.stdout)
})

Deno.test("zero-argument commands with their own action stay unchanged", async () => {
  const result = await run(["document"])

  assertEquals(result.code, 0, result.stderr)
  assertEquals(result.stderr, "")
  assertEquals(result.stdout, "Use --help to see available subcommands\n")
})

Deno.test("usage --json exposes the top-level command tree", async () => {
  const result = await run(["usage", "--json"])

  assertEquals(result.code, 0, result.stderr)
  assertEquals(result.stderr, "")
  const document = JSON.parse(result.stdout) as UsageDocument
  assertEquals(document.schemaVersion, 1)
  assertEquals(document.command.path, "linear")
  assertEquals(
    document.globalOptions.some((option) => option.name === "workspace"),
    true,
  )
  assertEquals(
    document.subcommands.some((command) =>
      command.name === "issue" && command.details === "linear issue usage"
    ),
    true,
  )
  assertEquals(
    document.subcommands.some((command) =>
      command.name === "api" && command.details === "linear api --help"
    ),
    true,
  )
  const api = document.subcommands.find((command) => command.name === "api")
  assertEquals(api?.writes, true)
  assertEquals(api?.interactive, false)
  assertEquals(api?.outputModes, ["json"])
  const version = document.subcommands.find((command) =>
    command.name === "version"
  )
  assertEquals(version?.writes, false)
  assertEquals(version?.interactive, false)
  assertEquals(version?.outputModes, ["human", "json"])
  const config = document.subcommands.find((command) =>
    command.name === "config"
  )
  assertEquals(config?.writes, true)
  assertEquals(config?.interactive, true)
  assertEquals(
    document.subcommands.some((command) => command.name === "usage"),
    false,
  )
})

Deno.test("domain usage includes direct command options", async () => {
  const result = await run(["issue", "usage"])

  assertEquals(result.code, 0, result.stderr)
  assertEquals(result.stderr, "")
  assertStringIncludes(result.stdout, "linear issue — Manage Linear issues")
  assertStringIncludes(result.stdout, "create [options]")
  assertStringIncludes(result.stdout, "create options:")
  assertStringIncludes(result.stdout, "--no-interactive")
  assertStringIncludes(result.stdout, "[writes; interactive]")
  assertStringIncludes(
    result.stdout,
    "[writes; interactive; confirm: --confirm]",
  )
  assertStringIncludes(result.stdout, "[interactive; json]")
  assertStringIncludes(
    result.stdout,
    "machine-readable: linear issue usage --json",
  )
})

Deno.test("Cliffy help keeps canonical human metadata labels", async () => {
  const deleteResult = await run(["issue", "delete", "--help"])
  assertEquals(deleteResult.code, 0, deleteResult.stderr)
  assertEquals(deleteResult.stderr, "")
  assertMatch(
    deleteResult.stdout,
    /\nWrites: true\s*\nInteractive: true\s*\nConfirmation required unless: --confirm\s*\n/,
  )

  const apiResult = await run(["api", "--help"])
  assertEquals(apiResult.code, 0, apiResult.stderr)
  assertEquals(apiResult.stderr, "")
  assertMatch(
    apiResult.stdout,
    /\nWrites: true\s*\nOutput modes: json\s*\n/,
  )
})

Deno.test("domain usage --json preserves arguments, aliases, and option types", async () => {
  const result = await run(["issue", "usage", "--json"])

  assertEquals(result.code, 0, result.stderr)
  assertEquals(result.stderr, "")
  const document = JSON.parse(result.stdout) as UsageDocument
  assertEquals(document.command.path, "linear issue")
  assertEquals(
    document.subcommands.some((command) => command.name === "usage"),
    false,
  )

  const mine = document.subcommands.find((command) => command.name === "mine")
  assertEquals(mine?.aliases, ["list", "l"])
  assertEquals(mine?.writes, false)
  assertEquals(mine?.interactive, true)
  assertEquals(
    mine?.options.some((option) =>
      ["assignee", "all-assignees", "unassigned"].includes(option.name)
    ),
    false,
  )
  assertEquals(
    mine?.options.find((option) => option.name === "state")?.default,
    ["unstarted"],
  )
  assertEquals(
    mine?.options.find((option) => option.name === "limit")?.default,
    50,
  )

  const attach = document.subcommands.find((command) =>
    command.name === "attach"
  )
  assertEquals(attach?.arguments.map((argument) => argument.name), [
    "issueId",
    "filepath",
  ])
  assertEquals(
    attach?.arguments.every((argument) => argument.required),
    true,
  )

  const create = document.subcommands.find((command) =>
    command.name === "create"
  )
  assertEquals(create?.writes, true)
  assertEquals(create?.interactive, true)
  assertEquals(create?.confirmation, null)
  assertEquals(create?.outputModes, ["human", "json"])
  const team = create?.options.find((option) => option.name === "team")
  assertEquals(team?.flags, ["--team"])
  assertEquals(team?.arguments[0]?.type, "string")
  assertEquals(team?.arguments[0]?.list, false)

  const deleteCommand = document.subcommands.find((command) =>
    command.name === "delete"
  )
  assertEquals(deleteCommand?.writes, true)
  assertEquals(deleteCommand?.interactive, true)
  assertEquals(deleteCommand?.confirmation, {
    requiredUnless: "--confirm",
  })

  const query = document.subcommands.find((command) => command.name === "query")
  assertEquals(query?.interactive, true)
  assertEquals(query?.outputModes, ["human", "json"])
})

Deno.test("usage --json exposes required options and canonical alias paths", async () => {
  const milestoneResult = await run(["milestone", "usage", "--json"])
  assertEquals(milestoneResult.code, 0, milestoneResult.stderr)
  const milestone = JSON.parse(milestoneResult.stdout) as UsageDocument
  const create = milestone.subcommands.find((command) =>
    command.name === "create"
  )
  assertEquals(
    create?.options.find((option) => option.name === "name")
      ?.staticallyRequired,
    true,
  )
  assertEquals(
    create?.options.find((option) => option.name === "project")
      ?.staticallyRequired,
    true,
  )

  const aliasResult = await run(["i", "usage", "--json"])
  assertEquals(aliasResult.code, 0, aliasResult.stderr)
  const aliasDocument = JSON.parse(aliasResult.stdout) as UsageDocument
  assertEquals(aliasDocument.command.path, "linear issue")
})

Deno.test("usage distinguishes list arguments from repeatable options", () => {
  const command = new Command()
    .name("sample")
    .description("Sample command")
    .option("--items <items:string[]>", "Comma-separated items")
    .option("--tag <tag:string>", "Repeatable tag", { collect: true })
  const options = buildUsageDocument(command).command.options

  const items = options.find((option) => option.name === "items")
  assertEquals(items?.arguments[0]?.list, true)
  assertEquals(items?.repeatable, false)
  assertEquals(
    options.find((option) => option.name === "tag")?.repeatable,
    true,
  )
})

Deno.test("usage omits defaults that are not static JSON values", () => {
  const command = new Command()
    .name("sample")
    .description("Sample command")
    .option("--static <value:string>", "Static default", {
      default: "static",
    })
    .option("--dynamic <value:string>", "Dynamic default", {
      default: () => "runtime",
    })
    .option("--unset <value:string>", "No default")
  const sourceOptions = command.getBaseOptions()
  const options = buildUsageDocument(command).command.options

  assertEquals(
    options.find((option) => option.name === "static")?.default,
    "static",
  )
  const dynamicOption = options.find((option) => option.name === "dynamic")
  const unsetOption = options.find((option) => option.name === "unset")
  assertExists(dynamicOption)
  assertExists(unsetOption)
  assertEquals("default" in dynamicOption, false)
  assertEquals("default" in unsetOption, false)
  const dynamicDefault = sourceOptions.find((option) =>
    option.name === "dynamic"
  )?.default
  assertEquals(typeof dynamicDefault, "function")
  if (typeof dynamicDefault === "function") {
    assertEquals(dynamicDefault(), "runtime")
  }
})

Deno.test("a usage JSON v1 reader ignores additive fields", () => {
  const document = buildUsageDocument(
    new Command()
      .name("sample")
      .description("Sample command")
      .option("--count <count:number>", "Count", { default: 1 }),
  )
  const withAdditions = {
    ...document,
    futureDocumentField: true,
    command: {
      ...document.command,
      futureCommandField: "new",
      options: document.command.options.map((option) => ({
        ...option,
        futureOptionField: null,
      })),
    },
  }
  const readV1 = (value: unknown) => {
    const parsed = value as UsageDocument
    return {
      schemaVersion: parsed.schemaVersion,
      path: parsed.command.path,
      writes: parsed.command.writes,
      options: parsed.command.options.map((option) => ({
        name: option.name,
        default: option.default,
      })),
    }
  }

  assertEquals(
    readV1(JSON.parse(JSON.stringify(withAdditions))),
    readV1(JSON.parse(JSON.stringify(document))),
  )
})

Deno.test("usage JSON v1 freezes its existing fields and types", async (t) => {
  const result = await run(["issue", "usage", "--json"])
  assertEquals(result.code, 0, result.stderr)
  assertEquals(result.stderr, "")
  // Additive fields may update this snapshot without changing schemaVersion.
  // Removing a field or changing its type requires a version increment.
  await assertSnapshot(t, JSON.parse(result.stdout))
})

Deno.test("writes metadata exactly matches canonical write commands", () => {
  const queue = [...cli.getCommands(true)]
  const actual: string[] = []
  for (const command of queue) {
    queue.push(...command.getCommands(true))
    const metadata = buildUsageDocument(command).command
    if (metadata.writes) actual.push(metadata.path)
  }

  assertEquals(actual.sort(), CANONICAL_WRITES_COMMAND_PATHS)
})

Deno.test("usage metadata stays aligned with the registered command tree", () => {
  const root = buildUsageDocument(cli)
  for (
    const command of root.subcommands.filter((item) =>
      item.hasSubcommands && item.name !== "completions"
    )
  ) {
    assertEquals(command.details, `${command.path} usage`)
  }

  const queue = [...cli.getCommands(true)]
  for (const command of queue) {
    queue.push(...command.getCommands(true))
    const metadata = buildUsageDocument(command).command
    const confirmationOption = command.getBaseOptions().find((option) =>
      /skip confirmation prompt/i.test(option.description)
    )
    if (confirmationOption == null) continue

    assertExists(
      metadata.confirmation,
      `${metadata.path} has a confirmation bypass option but no metadata`,
    )
    assertEquals(
      confirmationOption.flags.includes(
        metadata.confirmation.requiredUnless,
      ),
      true,
      `${metadata.path} confirmation metadata does not name its bypass option`,
    )
  }
})
