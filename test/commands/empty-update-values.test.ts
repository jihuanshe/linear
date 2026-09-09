import { Command } from "@cliffy/command"
import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert"
import { stub } from "@std/testing/mock"
import { updateCommand as issueUpdate } from "../../src/commands/issue/issue-update.ts"
import { updateCommand as projectUpdate } from "../../src/commands/project/project-update.ts"
import { setupMockLinearServer } from "../utils/test-helpers.ts"
import {
  connection,
  issue as issueFixture,
  WORKSPACE,
} from "../delivery/fixture.ts"

function readResponse(
  domain: "issue" | "project",
  id: string,
  identifier: string,
) {
  return {
    queryName: domain === "issue" ? "GetIssueForWrite" : "ReadProject",
    response: {
      data: {
        organization: WORKSPACE,
        [domain]: domain === "issue" ? issueFixture(123, { id, identifier }) : {
          id,
          name: "Original project",
          description: "Original description",
          startDate: null,
          targetDate: null,
          url: "https://example.com",
          archivedAt: null,
          status: { id: "status-1" },
          lead: null,
          teams: connection(),
          labels: connection(),
        },
      },
    },
  }
}

Deno.test("selective empty values - Command parser ownership and repeated parses", async () => {
  const command = new Command()
    .throwErrors()
    .option("-d, --description <value:string>", "Description", {
      preserveEmpty: true,
    })
    .option("--other <value:string>", "Other")
    .option("--number <value:number>", "Number")
    .option("--many <...values:string>", "Many")
    .option("--kept <...values:string>", "Kept", { preserveEmpty: true })
    .option("--pair <first:string> <second:string>", "Pair", {
      preserveEmpty: true,
    })
  for (const args of [["--description", ""], ["--description="], ["-d", ""]]) {
    assertEquals((await command.parse(args)).options, { description: "" })
  }
  assertEquals((await command.parse([])).options, {})
  assertEquals((await command.parse(["--other", "--description="])).options, {
    other: "--description=",
  })
  const literals = await command.parse(["--", "--description", ""])
  assertEquals(literals.options, {})
  assertEquals(literals.literal, ["--description", ""])
  assertEquals((await command.parse(["--other", ""])).options, {})
  assertEquals((await command.parse(["--number", ""])).options, {})
  assertEquals((await command.parse(["--number", "3"])).options, { number: 3 })
  assertEquals((await command.parse(["--many", "", "a"])).options, {
    many: ["a"],
  })
  assertEquals((await command.parse(["--kept", "", "a"])).options, {
    kept: ["", "a"],
  })
  assertEquals((await command.parse(["--pair", "", "a"])).options, {
    pair: ["", "a"],
  })
  await assertRejects(() => command.parse(["-d", "", "--description", "later"]))
  await assertRejects(() => command.parse(["--description"]))
  const option = command.getOption("description")!
  assertEquals(option.required, undefined)
  assertEquals(option.default, undefined)
  assertEquals(option.args?.[0].optional, false)
})

Deno.test("selective empty values - aliases and global option positions", async () => {
  const root = new Command()
    .throwErrors()
    .globalOption("--workspace <value:string>", "Workspace")
    .command(
      "update",
      new Command()
        .alias("u")
        .option("-d, --description <value:string>", "Description", {
          preserveEmpty: true,
        }),
    )
    .reset()
  for (
    const args of [
      ["--workspace", "test", "u", "-d", ""],
      ["update", "--description=", "--workspace", "test"],
    ]
  ) {
    assertEquals<Record<string, unknown>>((await root.parse(args)).options, {
      workspace: "test",
      description: "",
    })
  }
  assertEquals(
    (await root.parse(["--workspace", "--description=", "u"])).options,
    {
      workspace: "--description=",
    },
  )
})

for (
  const [domain, command, id, stableId, mutation, payload] of [
    [
      "issue",
      issueUpdate,
      "ENG-123",
      "550e8400-e29b-41d4-a716-446655440123",
      "UpdateIssue",
      "issueUpdate",
    ],
    [
      "project",
      projectUpdate,
      "550e8400-e29b-41d4-a716-446655440000",
      "550e8400-e29b-41d4-a716-446655440000",
      "UpdateProject",
      "projectUpdate",
    ],
  ] as const
) {
  Deno.test(`${domain} update - explicit empty values reach mutation; omitted stays omitted`, async () => {
    const file = await Deno.makeTempFile()
    const { server, cleanup } = await setupMockLinearServer([
      readResponse(domain, stableId, id),
      {
        queryName: mutation,
        response: {
          data: {
            [payload]: {
              success: true,
              [domain]: {
                id: stableId,
                identifier: id,
                name: "Project",
                title: "Issue",
                url: "https://example.com",
              },
            },
          },
        },
      },
    ])
    const writes = () =>
      server.graphqlRequests.filter((request) =>
        request.query.includes("mutation " + mutation)
      )
    const log = stub(console, "log", () => {})
    try {
      for (
        const args of [
          ["--description", ""],
          ["--description="],
          ["-d", ""],
          ["--description-file", file],
        ]
      ) {
        await command.parse([id, "--unprotected", ...args])
        assertEquals(writes().at(-1)?.variables, {
          id: stableId,
          input: { description: "" },
        })
      }
      const bytes = " \r\n# Preserve spacing\r\n\r\n "
      await Deno.writeTextFile(file, bytes)
      await command.parse([id, "--unprotected", "--description-file", file])
      assertEquals(writes().at(-1)?.variables, {
        id: stableId,
        input: { description: bytes },
      })
      const field = domain === "issue" ? "title" : "name"
      await command.parse([
        id,
        "--unprotected",
        `--${field}`,
        "Unchanged description",
      ])
      assertEquals(writes().at(-1)?.variables, {
        id: stableId,
        input: { [field]: "Unchanged description" },
      })
      assertEquals(writes().length, 6)
    } finally {
      log.restore()
      await cleanup()
      await Deno.remove(file)
    }
  })

  Deno.test(`${domain} update - empty path and conflicting empty inputs fail before requests`, async () => {
    const { server, cleanup } = await setupMockLinearServer([])
    const errors: string[] = []
    const error = stub(console, "error", (...args: unknown[]) => {
      errors.push(args.join(" "))
    })
    const exit = stub(Deno, "exit", () => {
      throw new Error("EXIT")
    })
    try {
      for (
        const args of [["--description-file", ""], ["--description-file="]]
      ) {
        await assertRejects(
          () => command.parse([id, "--unprotected", ...args]),
          Error,
          "EXIT",
        )
        assertStringIncludes(
          errors.join("\n"),
          "Description file path cannot be empty",
        )
      }
      errors.length = 0
      await assertRejects(
        () =>
          command.parse([
            id,
            "--unprotected",
            "--description",
            "",
            "--description-file",
            "",
          ]),
        Error,
        "EXIT",
      )
      assertStringIncludes(errors.join("\n"), "--description")
      assertStringIncludes(errors.join("\n"), "--description-file")
      assertEquals(server.graphqlRequests, [])
    } finally {
      exit.restore()
      error.restore()
      await cleanup()
    }
  })

  Deno.test(`${domain} update - production CLI preserves empty values through aliases`, async () => {
    const { server, cleanup } = await setupMockLinearServer([
      readResponse(domain, stableId, id),
      {
        queryName: mutation,
        response: {
          data: {
            [payload]: {
              success: true,
              [domain]: {
                id: stableId,
                identifier: id,
                name: "Project",
                title: "Issue",
              },
            },
          },
        },
      },
    ])
    const run = (args: string[]) =>
      new Deno.Command(Deno.execPath(), {
        args: ["run", "--allow-all", "--quiet", "src/main.ts", ...args],
        stdout: "piped",
        stderr: "piped",
      }).output()
    try {
      const alias = domain === "issue" ? "i" : "p"
      const result = await run([
        alias,
        "update",
        id,
        "--unprotected",
        "--description=",
      ])
      assertEquals(result.code, 0, new TextDecoder().decode(result.stderr))
      assertEquals(server.graphqlRequests.at(-1)?.variables, {
        id: stableId,
        input: { description: "" },
      })
      const requestsAfterWrite = server.graphqlRequests.length
      for (
        const args of [
          [
            "--workspace",
            "test",
            alias,
            "update",
            id,
            "--unprotected",
            "--description-file=",
          ],
          [
            alias,
            "update",
            id,
            "--unprotected",
            "--description-file",
            "",
            "--workspace",
            "test",
          ],
        ]
      ) {
        const invalid = await run(args)
        assertEquals(invalid.code, 1)
        assertStringIncludes(
          new TextDecoder().decode(invalid.stderr),
          "Description file path cannot be empty",
        )
      }
      assertEquals(server.graphqlRequests.length, requestsAfterWrite)
      assertEquals(
        server.graphqlRequests.filter((request) =>
          request.query.includes("mutation " + mutation)
        ).length,
        1,
      )
    } finally {
      await cleanup()
    }
  })
}
