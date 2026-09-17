import { Command } from "@cliffy/command"
import {
  assertEquals,
  assertExists,
  assertMatch,
  assertRejects,
  assertStringIncludes,
} from "@std/assert"
import { fromFileUrl } from "@std/path"
import { assertSnapshot } from "@std/testing/snapshot"
import { stub } from "@std/testing/mock"
import { cli } from "../../src/cli.ts"
import {
  isMachineOutput,
  setMachineOutput,
} from "../../src/utils/write-result.ts"
import { UnsupportedOutputError } from "../../src/utils/errors.ts"
import {
  buildUsageDocument,
  type UsageDocument,
} from "../../src/commands/usage.ts"

const main = fromFileUrl(new URL("../../src/main.ts", import.meta.url))
// Isolate credentials/configuration while reusing the installed dependency cache.
const { denoDir } = JSON.parse(new TextDecoder().decode(
  (await new Deno.Command(Deno.execPath(), {
    args: ["info", "--json"],
    stdout: "piped",
  }).output()).stdout,
)) as { denoDir: string }

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
  "linear issue comment resolve",
  "linear issue comment unresolve",
  "linear issue comment update",
  "linear issue create",
  "linear issue delete",
  "linear issue link",
  "linear issue relation add",
  "linear issue relation delete",
  "linear issue update",
  "linear label create",
  "linear label delete",
  "linear milestone create",
  "linear milestone delete",
  "linear milestone update",
  "linear project create",
  "linear project delete",
  "linear project update",
  "linear project-update create",
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
        DENO_DIR: denoDir,
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
  await assertSnapshot(t, result.stdout)
  assertEquals(
    new TextEncoder().encode(result.stdout).byteLength <= 2_000,
    true,
  )
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

Deno.test("document navigation reuses generated usage", async () => {
  const [result, explicitUsage] = await Promise.all([
    run(["document"]),
    run(["document", "usage"]),
  ])

  assertEquals(result.code, 0, result.stderr)
  assertEquals(result.stderr, "")
  assertEquals(explicitUsage.code, 0, explicitUsage.stderr)
  assertEquals(result.stdout, explicitUsage.stdout)
})

Deno.test("usage --json exposes the top-level command tree", async () => {
  const result = await run(["usage", "--json"])

  assertEquals(result.code, 0, result.stderr)
  assertEquals(result.stderr, "")
  const document = JSON.parse(result.stdout) as UsageDocument
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
  assertStringIncludes(result.stdout, "[writes; interactive; json]")
  assertStringIncludes(result.stdout, "[interactive; json]")
  assertStringIncludes(
    result.stdout,
    "machine-readable: linear issue usage --json",
  )
})

Deno.test("nested command groups expose usage recursively", async () => {
  const result = await run(["issue", "comment", "usage"])

  assertEquals(result.code, 0, result.stderr)
  assertEquals(result.stderr, "")
  assertStringIncludes(result.stdout, "linear issue comment")
  for (
    const command of [
      "add",
      "list",
      "view",
      "update",
      "delete",
      "resolve",
      "unresolve",
    ]
  ) {
    assertMatch(result.stdout, new RegExp(`\\n  ${command}(?: |\\[)`))
  }

  const jsonResult = await run(["issue", "comment", "usage", "--json"])
  assertEquals(jsonResult.code, 0, jsonResult.stderr)
  assertEquals(jsonResult.stderr, "")
  const document = JSON.parse(jsonResult.stdout) as UsageDocument
  assertEquals(document.command.path, "linear issue comment")
  assertEquals(
    document.subcommands.map(({ name }) => name).sort(),
    ["add", "delete", "list", "resolve", "unresolve", "update", "view"],
  )
  for (const command of document.subcommands) {
    assertEquals(command.path, `linear issue comment ${command.name}`)
    assertEquals(command.details, `${command.path} --help`)
  }
})

Deno.test("Cliffy help keeps canonical human metadata labels", async () => {
  const deleteResult = await run(["issue", "delete", "--help"])
  assertEquals(deleteResult.code, 0, deleteResult.stderr)
  assertEquals(deleteResult.stderr, "")
  assertMatch(
    deleteResult.stdout,
    /\nWrites: true\s*\nInteractive: true\s*\n/,
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

  const attach = document.subcommands.find((command) =>
    command.name === "attach"
  )
  assertEquals(attach?.arguments.map((argument) => argument.name), [
    "issue",
    "path",
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
  assertEquals(create?.outputModes, ["human", "json"])
  const team = create?.options.find((option) => option.name === "team")
  assertEquals(team?.flags, ["--team"])
  assertEquals(team?.arguments[0]?.type, "string")

  const priority = create?.options.find((option) => option.name === "priority")
  assertEquals(priority?.arguments[0]?.type, "priority")

  const deleteCommand = document.subcommands.find((command) =>
    command.name === "delete"
  )
  assertEquals(deleteCommand?.writes, true)
  assertEquals(deleteCommand?.interactive, true)

  const query = document.subcommands.find((command) => command.name === "query")
  assertEquals(query?.aliases, ["q"])
  assertEquals(query?.interactive, true)
  assertEquals(query?.outputModes, ["human", "json"])

  const view = document.subcommands.find((command) => command.name === "view")
  assertEquals(view?.writes, false)
})

Deno.test("usage names flexible references by resource and reserves Id suffixes for UUIDs", () => {
  for (
    const [path, argumentNames] of [
      ["issue view", ["issue"]],
      ["issue update", ["issue"]],
      ["issue delete", ["issue"]],
      ["issue comment add", ["issue"]],
      ["issue comment list", ["issue"]],
      ["project view", ["project"]],
      ["project update", ["project"]],
      ["project delete", ["project"]],
      ["project teams", ["project"]],
      ["project-update create", ["project"]],
      ["project-update list", ["project"]],
      ["initiative view", ["initiative"]],
      ["initiative update", ["initiative"]],
      ["initiative delete", ["initiative"]],
      ["initiative archive", ["initiative"]],
      ["initiative unarchive", ["initiative"]],
      ["initiative add-project", ["initiative", "project"]],
      ["initiative remove-project", ["initiative", "project"]],
      ["initiative-update create", ["initiative"]],
      ["initiative-update list", ["initiative"]],
      ["document view", ["document"]],
      ["document update", ["document"]],
      ["document delete", ["document"]],
      ["label delete", ["label"]],
      ["cycle view", ["cycle"]],
      ["team members", ["team"]],
      ["team states", ["team"]],
      ["team delete", ["team"]],
      ["issue comment view", ["commentId"]],
      ["issue comment update", ["commentId"]],
      ["issue comment delete", ["commentId"]],
      ["issue comment resolve", ["commentId"]],
      ["issue comment unresolve", ["commentId"]],
      ["milestone update", ["milestoneId"]],
      ["milestone delete", ["milestoneId"]],
      ["auth default", ["slug"]],
      ["auth logout", ["slug"]],
    ] as const
  ) {
    let command = cli
    for (const segment of path.split(" ")) {
      const child = command.getCommand(segment)
      assertExists(child, path)
      command = child as typeof cli
    }
    assertEquals(
      buildUsageDocument(command).command.arguments.map(({ name }) => name),
      [...argumentNames],
      path,
    )
  }

  const uuidArguments = ["commentId", "relationId", "updateId", "milestoneId"]
  const queue = [...cli.getCommands(true)]
  for (const command of queue) {
    queue.push(...command.getCommands(true))
    const metadata = buildUsageDocument(command).command
    for (const argument of metadata.arguments) {
      if (argument.name.endsWith("Id")) {
        assertEquals(
          uuidArguments.includes(argument.name),
          true,
          `${metadata.path}: ${argument.name} is not a UUID-only argument`,
        )
      }
    }
  }
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

Deno.test("usage distinguishes scalar and repeatable options", () => {
  const command = new Command()
    .name("sample")
    .description("Sample command")
    .option("--title <title:string>", "Title")
    .option("--tag <tag:string>", "Repeatable tag", { collect: true })
  const options = buildUsageDocument(command).command.options

  assertEquals(
    options.find((option) => option.name === "title")?.repeatable,
    false,
  )
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

Deno.test("usage JSON describes command metadata", async (t) => {
  const result = await run(["issue", "usage", "--json"])
  assertEquals(result.code, 0, result.stderr)
  assertEquals(result.stderr, "")
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

Deno.test("selection metadata and protected replacement options remain discoverable", () => {
  const issue = cli.getCommand("issue")!
  const team = cli.getCommand("team")!
  assertEquals(
    buildUsageDocument(issue.getCommand("pick")!).command.writes,
    false,
  )
  assertEquals(
    buildUsageDocument(team.getCommand("key")!).command.writes,
    false,
  )
  for (
    const path of [
      "issue update",
      "issue comment update",
      "project update",
      "initiative update",
      "document update",
      "milestone update",
    ]
  ) {
    let command = cli
    for (const segment of path.split(" ")) {
      command = command.getCommand(segment)! as typeof cli
    }
    const metadata = buildUsageDocument(command).command
    for (const name of ["base-file", "unprotected", "expect-field", "json"]) {
      assertEquals(
        metadata.options.some((option) => option.name === name),
        true,
        `${path} missing ${name}`,
      )
    }
  }
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
})

Deno.test("global JSON inheritance does not advertise unsupported leaves as capable", () => {
  const queue = [...cli.getCommands(true)]
  for (const command of queue) {
    queue.push(...command.getCommands(true))
    const metadata = buildUsageDocument(command).command
    const local = command.getBaseOptions().find((option) =>
      option.name === "json" && !option.global
    )
    if (local != null) {
      assertEquals(local.aliases?.includes("j"), true, metadata.path)
      assertEquals(local.flags.includes("-j"), true, metadata.path)
      assertEquals(metadata.outputModes.includes("json"), true, metadata.path)
    } else if (!command.hasCommands() && metadata.path !== "linear api") {
      assertEquals(metadata.outputModes, ["human"], metadata.path)
    }
  }
  const auth = buildUsageDocument(cli.getCommand("auth")!)
  assertEquals(auth.command.outputModes, ["human", "json"])
  assertEquals(
    auth.globalOptions.find((option) => option.name === "json")?.flags,
    [
      "-j",
      "--json",
    ],
  )
  assertEquals(
    auth.subcommands.find((command) => command.name === "login")?.outputModes,
    ["human"],
  )
})

Deno.test("repeated parses isolate JSON selection and preserve standalone human help", async () => {
  const lines: string[] = []
  const log = stub(
    console,
    "log",
    (...args: unknown[]) => lines.push(args.join(" ")),
  )
  try {
    for (const json of ["-j", "--json"]) {
      await cli.parse([json, "version"])
      assertEquals(JSON.parse(lines.pop()!).distribution, "jihuanshe/linear")
      assertEquals(isMachineOutput(), true)
      await cli.parse(["version"])
      assertMatch(lines.pop()!, /^distribution:/)
      assertEquals(isMachineOutput(), false)
      await assertRejects(
        () => cli.parse(["auth", "login", json]),
        UnsupportedOutputError,
      )
      assertEquals(isMachineOutput(), true)
      await cli.parse(["--help"])
      assertMatch(lines.pop()!, /Usage:\s+linear/)
      assertEquals(isMachineOutput(), false)
      await cli.parse(["--workspace", json, "version"])
      assertMatch(lines.pop()!, /^distribution:/)
      assertEquals(isMachineOutput(), false)
    }
    assertEquals(lines, [])
  } finally {
    log.restore()
    setMachineOutput(false)
  }
})
