import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert"
import { updateIssueAndVerify } from "../../../src/commands/issue/issue-update.ts"
import { WriteError } from "../../../src/utils/errors.ts"
import {
  issueWriteBasis,
  issueWriteId,
} from "../../utils/issue-write-fixtures.ts"
import {
  commonDenoArgs,
  setupMockLinearServer,
} from "../../utils/test-helpers.ts"

type Basis = ReturnType<typeof issueWriteBasis>

async function fixture(
  observe: (
    written: Basis,
    attempt: number,
  ) => Record<string, unknown> | Promise<Record<string, unknown>>,
  { initial = issueWriteBasis(), mutationSuccess = true } = {},
) {
  let writes = 0
  let readsAfterWrite = 0
  const current = structuredClone(initial)
  const { server, cleanup } = await setupMockLinearServer([
    {
      queryName: "GetIssueForWrite",
      response: () =>
        writes
          ? observe(structuredClone(current), ++readsAfterWrite)
          : { data: structuredClone(current) },
    },
    {
      queryName: "GetIssueLabelIdByNameForTeam",
      response: ({ variables }) => ({
        data: {
          issueLabels: {
            nodes: [{ id: `label-${variables.name}`, name: variables.name }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      }),
    },
    {
      queryName: "UpdateIssue",
      response: ({ variables }) => {
        writes++
        const input = variables.input as Record<string, unknown>
        if (typeof input.title === "string") current.issue.title = input.title
        if (typeof input.description === "string") {
          current.issue.description = input.description
        }
        return {
          data: {
            issueUpdate: {
              success: mutationSuccess,
              issue: structuredClone(current.issue),
            },
          },
        }
      },
    },
  ])
  return { server, cleanup, writes: () => writes, reads: () => readsAfterWrite }
}

async function command(args: string[]) {
  const result = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      ...commonDenoArgs,
      "src/main.ts",
      "issue",
      "update",
      "ENG-123",
      "--unprotected",
      "--json",
      ...args,
    ],
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output()
  assertEquals(new TextDecoder().decode(result.stderr), "")
  return {
    code: result.code,
    output: JSON.parse(new TextDecoder().decode(result.stdout)),
  }
}

Deno.test("issue update retries stale reads and accepts Linear Markdown normalization", async () => {
  const desired =
    "情况已确认。\n\n+++ 来源与接手\n\n- [来源](https://example.com/反馈)\n\n- [修复单](https://example.com/case)\n\n+++\n"
  const actual =
    "情况已确认。\n\n+++ 来源与接手\n\n* [来源](<https://example.com/%E5%8F%8D%E9%A6%88>)\n* [修复单](<https://example.com/case>)\n\n+++"
  const f = await fixture((written, attempt) => ({
    data: attempt < 3
      ? issueWriteBasis()
      : { ...written, issue: { ...written.issue, description: actual } },
  }))
  try {
    const result = await command(["--description", desired])
    assertEquals(result.code, 0)
    assertEquals(result.output.effect, "applied")
    assertEquals(result.output.verification.status, "verified")
    assertEquals(result.output.readBack.issue.description, actual)
    assertEquals(result.output.data.issue.description, desired)
    assertEquals(f.reads(), 3)
    assertEquals(f.writes(), 1)
    const readbacks = f.server.graphqlRequests.filter((r) =>
      r.query.includes("GetIssueForWrite")
    ).slice(-3)
    assertEquals(readbacks.map((r) => r.variables.id), [
      issueWriteId,
      issueWriteId,
      issueWriteId,
    ])
  } finally {
    await f.cleanup()
  }
})

for (
  const mode of [
    "different",
    "unavailable",
    "auth",
    "shape",
    "workspace",
    "identity",
  ] as const
) {
  Deno.test(`issue update ${mode} read-back fails with the applied receipt and no mutation replay`, async () => {
    const f = await fixture((written) =>
      mode === "unavailable"
        ? { errors: [{ message: "Read permission lost" }] }
        : mode === "auth"
        ? {
          errors: [{
            message: "Authentication required",
            extensions: { code: "UNAUTHENTICATED" },
          }],
        }
        : mode === "shape"
        ? { data: { organization: written.organization } }
        : {
          data: {
            ...written,
            ...(mode === "workspace"
              ? { organization: { id: "another-workspace", urlKey: "other" } }
              : {}),
            issue: {
              ...written.issue,
              ...(mode === "different"
                ? { description: "第一段\n第二段" }
                : {}),
              ...(mode === "identity"
                ? { id: "99999999-9999-4999-8999-999999999999" }
                : {}),
            },
          },
        }
    )
    try {
      const result = await command(["--description", "第一段\n\n第二段"])
      assertEquals(result.code, 1)
      assertEquals(result.output.ok, false)
      assertEquals(result.output.effect, "applied")
      assertEquals(result.output.data.success, true)
      assertEquals(result.output.data.issue.id, issueWriteId)
      assertEquals(
        result.output.error.details.verification.status,
        mode === "different" ? "different" : "unavailable",
      )
      assertStringIncludes(result.output.error.suggestion, "do not repeat")
      assertEquals(f.reads(), mode === "different" ? 3 : 1)
      assertEquals(f.writes(), 1)
    } finally {
      await f.cleanup()
    }
  })
}

Deno.test("issue update leaves rate-limit retries to transport without restarting failed verification", async () => {
  const f = await fixture(() => ({
    errors: [{ message: "Slow down", extensions: { code: "RATELIMITED" } }],
  }))
  try {
    const result = await command(["--title", "Renamed"])
    assertEquals(result.code, 1)
    assertEquals(result.output.effect, "applied")
    assertEquals(result.output.error.details.verification.status, "unavailable")
    assertStringIncludes(
      result.output.error.details.verification.detail,
      "Slow down",
    )
    assertEquals(f.reads(), 3)
    assertEquals(f.writes(), 1)
  } finally {
    await f.cleanup()
  }
})

for (const visible of [true, false]) {
  Deno.test(`issue update verifies incremental label membership: ${visible}`, async () => {
    const f = await fixture((written) => ({
      data: {
        ...written,
        issue: {
          ...written.issue,
          labels: {
            nodes: visible
              ? [{ id: "label-front", name: "front" }, {
                id: "unrelated",
                name: "other",
              }]
              : written.issue.labels.nodes,
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    }))
    try {
      const result = await command([
        "--add-label",
        "front",
        "--remove-label",
        "before",
      ])
      assertEquals(result.code, visible ? 0 : 1)
      assertEquals(result.output.effect, "applied")
      assertEquals(f.writes(), 1)
      const mutation = f.server.graphqlRequests.find((r) =>
        r.query.includes("mutation UpdateIssue")
      )!
      assertEquals(mutation.variables.input, {
        addedLabelIds: ["label-front"],
        removedLabelIds: ["label-before"],
      })
    } finally {
      await f.cleanup()
    }
  })
}

Deno.test("issue update read-back deadline preserves an acknowledged mutation", async () => {
  const f = await fixture(async (written) => {
    await new Promise((resolve) => setTimeout(resolve, 100))
    return { data: written }
  })
  try {
    const error = await assertRejects(
      () =>
        updateIssueAndVerify(
          { title: "Renamed", unprotected: true },
          "ENG-123",
          { verificationTimeoutMs: 20 },
        ),
      WriteError,
    )
    assertEquals(error.effect, "applied")
    assertStringIncludes(JSON.stringify(error.details), "timed out")
    assertEquals(f.writes(), 1)
    await new Promise((resolve) => setTimeout(resolve, 110))
  } finally {
    await f.cleanup()
  }
})

Deno.test("issue update no-op returns without a mutation or a verification read", async () => {
  const f = await fixture(() => {
    throw new Error("unexpected read-back")
  })
  try {
    const result = await command(["--title", "Before title"])
    assertEquals(result.code, 0)
    assertEquals(result.output.effect, "none")
    assertEquals(f.reads(), 0)
    assertEquals(f.writes(), 0)
    assertEquals(f.server.graphqlRequests.length, 2)
  } finally {
    await f.cleanup()
  }
})

Deno.test("issue update unconfirmed mutation does not start read-back or replay", async () => {
  const f = await fixture(() => {
    throw new Error("unexpected read-back")
  }, { mutationSuccess: false })
  try {
    const result = await command(["--title", "Renamed"])
    assertEquals(result.code, 1)
    assertEquals(result.output.effect, "unknown")
    assertEquals(f.reads(), 0)
    assertEquals(f.writes(), 1)
  } finally {
    await f.cleanup()
  }
})

for (const lifecycle of ["archived", "trashed"] as const) {
  Deno.test(`issue update verifies requested fields despite a later ${lifecycle} transition`, async () => {
    const f = await fixture((written) => ({
      data: {
        ...written,
        issue: {
          ...written.issue,
          ...(lifecycle === "archived"
            ? { archivedAt: "2026-09-01T00:00:00Z" }
            : { trashed: true }),
        },
      },
    }))
    try {
      const result = await command(["--title", "Renamed"])
      assertEquals(result.code, 0)
      assertEquals(result.output.verification.status, "verified")
      assertEquals(result.output.readBack.issue.title, "Renamed")
      assertEquals(f.writes(), 1)
    } finally {
      await f.cleanup()
    }
  })
}
