import { Command } from "@cliffy/command"
import { assertEquals, assertExists, assertStringIncludes } from "@std/assert"
import { fromFileUrl } from "@std/path"
import { assertSnapshot } from "@std/testing/snapshot"
import { cli } from "../../src/cli.ts"
import {
  buildUsageDocument,
  type UsageDocument,
} from "../../src/commands/usage.ts"

const main = fromFileUrl(new URL("../../src/main.ts", import.meta.url))

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
  assertStringIncludes(result.stdout, "detail: linear <domain> usage")
  assertStringIncludes(result.stdout, "machine-readable: linear usage --json")
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
  assertStringIncludes(result.stdout, "confirm: --confirm")
  assertStringIncludes(
    result.stdout,
    "machine-readable: linear issue usage --json",
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
  assertEquals(create?.outputModes, ["human"])
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

Deno.test("usage --json has a stable domain contract", async (t) => {
  const result = await run(["issue", "usage", "--json"])
  assertEquals(result.code, 0, result.stderr)
  assertEquals(result.stderr, "")
  await assertSnapshot(t, JSON.parse(result.stdout))
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

  const queue = [...cli.getCommands()]
  for (const command of queue) {
    queue.push(...command.getCommands())
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
