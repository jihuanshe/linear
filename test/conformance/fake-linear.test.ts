/**
 * The fake Linear's HTTP behavior that conformance assertions rely on:
 * mutation counts and faults follow what GraphQL executes, rejected inputs
 * leave the store unchanged, and every HTTP attempt is counted.
 */
import { assertEquals } from "@std/assert"
import {
  API_KEY,
  FakeLinear,
  type FaultRule,
} from "../../conformance/fake-linear/server.ts"
import { Store } from "../../conformance/fake-linear/store.ts"

const world = JSON.parse(
  Deno.readTextFileSync(
    new URL("../../conformance/world.json", import.meta.url),
  ),
)
const TEAM = "0c000000-0000-4000-8000-000000000001"
const UNKNOWN_LABEL = "0e000000-0000-4000-8000-0000000000ff"

async function withFake(
  run: (fake: FakeLinear) => Promise<void>,
): Promise<void> {
  const store = new Store(world)
  store.seed({
    Issue: [{
      id: "1a000000-0000-4000-8000-000000000001",
      identifier: "ENG-7",
      number: 7,
      team: TEAM,
      state: "0d000000-0000-4000-8000-000000000002",
      title: "Old title",
      description: null,
      priority: 0,
      labels: [],
      creator: "0b000000-0000-4000-8000-000000000001",
      createdAt: "2025-06-01T00:00:00.000Z",
      updatedAt: "2025-06-01T00:00:00.000Z",
      archivedAt: null,
      trashed: null,
    }],
  })
  const fake = new FakeLinear(store)
  fake.start()
  try {
    await run(fake)
  } finally {
    await fake.stop()
  }
}

async function post(
  fake: FakeLinear,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<number> {
  const response = await fetch(fake.endpoint, {
    method: "POST",
    headers: { authorization: API_KEY, "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  })
  await response.body?.cancel()
  return response.status
}

const titles = (fake: FakeLinear) =>
  fake.snapshot().Issue.map((issue) => issue.title)

Deno.test("fake-linear - faults and mutation counts see root fields selected through fragments", async () => {
  const update = `issueUpdate(id: "ENG-7", input: {title: "T"}) { success }`
  const fault: FaultRule = {
    on: "mutation:issueUpdate",
    action: "status",
    status: 503,
  }
  for (
    const [query, variables, expected] of [
      [`mutation { ...M } fragment M on Mutation { ${update} }`, {}, 1],
      [`mutation { ... on Mutation { ${update} } }`, {}, 1],
      [
        `mutation { ...M @skip(if: true) } fragment M on Mutation { ${update} }`,
        {},
        0,
      ],
      [`mutation($on: Boolean!) { ... @include(if: $on) { ${update} } }`, {
        on: false,
      }, 0],
    ] as const
  ) {
    await withFake(async (fake) => {
      fake.faults = [fault]
      const status = await post(fake, query, variables)
      assertEquals(status, expected === 1 ? 503 : 200, query)
      assertEquals(
        fake.mutationCounts(),
        expected === 1 ? { issueUpdate: 1 } : {},
        query,
      )
    })
  }
})

Deno.test("fake-linear - a rejected issue input leaves the store unchanged", async () => {
  await withFake(async (fake) => {
    await post(
      fake,
      `mutation { issueUpdate(id: "ENG-7", input: {title: "Partial", labelIds: ["${UNKNOWN_LABEL}"]}) { success } }`,
    )
    await post(
      fake,
      `mutation { issueCreate(input: {teamId: "${TEAM}", title: "Ghost", labelIds: ["${UNKNOWN_LABEL}"]}) { success } }`,
    )
    assertEquals(titles(fake), ["Old title"])
  })
})

Deno.test("fake-linear - attempts count requests rejected before GraphQL", async () => {
  await withFake(async (fake) => {
    for (
      const init of [
        { method: "GET" },
        { method: "POST", headers: { authorization: "wrong" }, body: "{}" },
        { method: "POST", headers: { authorization: API_KEY }, body: "x" },
      ]
    ) {
      const response = await fetch(fake.endpoint, init)
      await response.body?.cancel()
    }
    assertEquals(fake.attempts, 3)
  })
})
