import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert"
import { stub } from "@std/testing/mock"
import { Input, Select } from "@cliffy/prompt"
import {
  createCommand,
  prepareIssueCreate,
} from "../../../src/commands/issue/issue-create.ts"
import { prepareIssueUpdate } from "../../../src/commands/issue/issue-update.ts"
import { ValidationError } from "../../../src/utils/errors.ts"
import {
  issueWriteId,
  setupIssueWriteServer,
  teamWriteIds,
  terminalPage,
} from "../../utils/issue-write-fixtures.ts"
import { commonDenoArgs } from "../../utils/test-helpers.ts"

const exactText = "\uFEFF \r\nAlpha  \r\n\tBeta\n \t"
const invalidUtf8 = new Uint8Array([0x41, 0xc3, 0x28, 0x42])
const issue = {
  id: issueWriteId,
  identifier: "ENG-123",
  url: "https://linear.app/test-team/issue/ENG-123",
  team: { key: "ENG" },
}
const responses = [
  {
    queryName: "GetWriteTeamByKey",
    response: {
      data: {
        teams: {
          nodes: [{ id: teamWriteIds.ENG, key: "ENG" }],
          pageInfo: terminalPage,
        },
      },
    },
  },
  {
    queryName: "CreateIssue",
    response: { data: { issueCreate: { success: true, issue } } },
  },
  {
    queryName: "UpdateIssue",
    response: { data: { issueUpdate: { success: true, issue } } },
  },
]

for (const operation of ["create", "update"]) {
  for (const source of ["inline", "file", "stdin"]) {
    for (
      const value of source === "inline"
        ? ["exact", "empty"]
        : ["exact", "empty", "invalid"]
    ) {
      Deno.test(`issue ${operation} description preserves ${source} ${value}`, async () => {
        const { server, cleanup } = await setupIssueWriteServer(responses, {
          LINEAR_ISSUE_CREATE_ASSIGN_SELF: "never",
        })
        const file = await Deno.makeTempFile()
        const expected = value === "empty" ? "" : exactText
        const bytes = value === "invalid"
          ? invalidUtf8
          : new TextEncoder().encode(expected)
        try {
          await Deno.writeFile(file, bytes)
          const process = new Deno.Command(Deno.execPath(), {
            args: [
              "run",
              ...commonDenoArgs,
              "src/main.ts",
              "issue",
              operation,
              ...(operation === "create"
                ? ["--title", "Description", "--team", "ENG"]
                : ["ENG-123", "--unprotected"]),
              ...(source === "inline"
                ? ["--description", expected]
                : ["--description-file", source === "stdin" ? "-" : file]),
              "--json",
            ],
            stdin: "piped",
            stdout: "piped",
            stderr: "piped",
          }).spawn()
          const writer = process.stdin.getWriter()
          await writer.write(source === "stdin" ? bytes : new Uint8Array())
          await writer.close()
          const result = await process.output()
          const body = JSON.parse(new TextDecoder().decode(result.stdout))
          assertEquals(
            result.code,
            value === "invalid" ? 1 : 0,
            JSON.stringify(body),
          )
          const writes = server.graphqlRequests.filter((request) =>
            request.query.includes("mutation ")
          )
          assertEquals(writes.length, value === "invalid" ? 0 : 1)
          if (value === "invalid") {
            assertStringIncludes(
              body.error.message,
              "Failed to read description file",
            )
            assertEquals(body.effect, "none")
            assertEquals(server.graphqlRequests, [])
          } else {
            assertEquals(body.effect, "applied")
            assertEquals(
              (writes[0].variables.input as Record<string, unknown>)
                .description,
              expected,
            )
          }
        } finally {
          await Deno.remove(file)
          await cleanup()
        }
      })
    }
  }
}

for (const operation of ["create", "update"]) {
  Deno.test(`issue ${operation} preparation reads strict UTF-8 exactly once`, async () => {
    const { server, cleanup } = await setupIssueWriteServer(responses, {
      LINEAR_ISSUE_CREATE_ASSIGN_SELF: "never",
    })
    const file = await Deno.makeTempFile()
    const readFile = Deno.readFile.bind(Deno)
    let reads = 0
    const read = stub(
      Deno,
      "readFile",
      async (path: string | URL, options?: Deno.ReadFileOptions) => {
        if (path === file) reads++
        return await readFile(path, options)
      },
    )
    const prepare = () =>
      operation === "create"
        ? prepareIssueCreate({
          title: "Description",
          team: "ENG",
          descriptionFile: file,
        })
        : prepareIssueUpdate(
          { descriptionFile: file, unprotected: true },
          "ENG-123",
        ).then((result) => result.input)
    try {
      await Deno.writeTextFile(file, exactText)
      assertEquals((await prepare()).description, exactText)
      assertEquals(reads, 1)
      await Deno.writeFile(file, invalidUtf8)
      server.graphqlRequests.length = 0
      await assertRejects(
        prepare,
        ValidationError,
        "Failed to read description file",
      )
      assertEquals(reads, 2)
      assertEquals(server.graphqlRequests, [])
    } finally {
      read.restore()
      await Deno.remove(file)
      await cleanup()
    }
  })
}

for (
  const source of [
    "prompt",
    "editor",
    "failed-editor",
    "missing-editor",
    "invalid-editor",
  ]
) {
  for (
    const expected of source === "prompt"
      ? [exactText, " \t", ""]
      : source === "editor"
      ? [exactText, ""]
      : [exactText]
  ) {
    Deno.test(`interactive issue description ${source} handles ${JSON.stringify(expected)}`, async () => {
      const directory = await Deno.makeTempDir()
      const editor = `${directory}/editor`
      const contentFile = `${directory}/content`
      const gitConfig = `${directory}/gitconfig`
      await Deno.writeTextFile(gitConfig, "")
      await Deno.writeFile(
        contentFile,
        source === "invalid-editor"
          ? invalidUtf8
          : new TextEncoder().encode(expected),
      )
      await Deno.writeTextFile(
        editor,
        source === "failed-editor"
          ? "#!/bin/sh\nexit 7\n"
          : `#!/bin/sh\ncat '${contentFile}' > "$1"\n`,
      )
      await Deno.chmod(editor, 0o700)
      const { server, cleanup } = await setupIssueWriteServer([
        ...responses,
        {
          queryName: "GetWorkflowStates",
          response: { data: { team: { states: { nodes: [] } } } },
        },
        {
          queryName: "GetLabelsForTeam",
          response: { data: { team: { labels: { nodes: [] } } } },
        },
      ], {
        LINEAR_TEAM_KEY: "ENG",
        LINEAR_ISSUE_CREATE_ASSIGN_SELF: "never",
        LINEAR_ISSUE_CREATE_ASK_PROJECT: "false",
        GIT_CONFIG_GLOBAL: gitConfig,
        GIT_CONFIG_NOSYSTEM: "1",
        EDITOR: source === "missing-editor" ? "" : editor,
      })
      const stdin = stub(
        Object.getPrototypeOf(Deno.stdin),
        "isTerminal",
        () => true,
      )
      const stdout = stub(
        Object.getPrototypeOf(Deno.stdout),
        "isTerminal",
        () => true,
      )
      const input = stub(
        Input,
        "prompt",
        (options: string | { message: string }) => {
          const message = typeof options === "string"
            ? options
            : options.message
          return Promise.resolve(
            message.startsWith("Description")
              ? source === "prompt" ? expected : "e"
              : "Description",
          )
        },
      )
      const select = stub(Select, "prompt", () => Promise.resolve("submit"))
      const log = stub(console, "log", () => {})
      const errors: string[] = []
      const stderr = stub(console, "error", (...args: unknown[]) => {
        errors.push(args.join(" "))
      })
      const exit = stub(Deno, "exit", () => {
        throw new Error("EXIT")
      })
      try {
        const success = source === "prompt" || source === "editor"
        if (success) {
          await createCommand.parse([])
        } else {
          await assertRejects(() => createCommand.parse([]), Error, "EXIT")
          assertStringIncludes(
            errors.join("\n"),
            source === "failed-editor"
              ? "Editor exited with an error"
              : source === "missing-editor"
              ? "No editor found"
              : "Failed to read content file",
          )
        }
        const writes = server.graphqlRequests.filter((request) =>
          request.query.includes("mutation ")
        )
        assertEquals(writes.length, success ? 1 : 0)
        if (success) {
          const input = writes[0].variables.input as Record<string, unknown>
          const skipped = source === "prompt" && expected === ""
          assertEquals(input.useDefaultTemplate, true)
          assertEquals(Object.hasOwn(input, "description"), !skipped)
          assertEquals(
            input.description,
            skipped ? undefined : expected,
          )
        }
      } finally {
        exit.restore()
        stderr.restore()
        log.restore()
        select.restore()
        input.restore()
        stdout.restore()
        stdin.restore()
        await cleanup()
        await Deno.remove(directory, { recursive: true })
      }
    })
  }
}
