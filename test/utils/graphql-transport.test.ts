import { assertEquals, assertRejects } from "@std/assert"
import { stub } from "@std/testing/mock"
import { FakeTime } from "@std/testing/time"
import { graphqlFetch } from "../../src/utils/graphql-transport.ts"

const start = Date.parse("2026-09-15T12:00:00Z")
const query = "query Read { viewer { id } }"
const mutation = "mutation Write { issueUpdate { success } }"
const rateLimit = {
  errors: [{ message: "Slow down", extensions: { code: "RATELIMITED" } }],
}

function clock(random = 0) {
  const time = new FakeTime(start)
  const now = stub(performance, "now", () => time.now)
  const jitter = stub(Math, "random", () => random)
  return {
    time,
    [Symbol.dispose]() {
      jitter.restore()
      now.restore()
      time.restore()
    },
  }
}

function request(
  document = query,
  signal?: AbortSignal,
  operationName?: string,
) {
  return graphqlFetch("https://example.invalid/graphql", {
    method: "POST",
    body: JSON.stringify({ query: document, operationName }),
    signal,
  })
}

for (const status of [429, 502, 503, 504]) {
  for (const document of [query, mutation]) {
    Deno.test(`GraphQL transport HTTP ${status}: ${document.split(" ")[0]}`, async () => {
      using c = clock()
      const dispatches: number[] = []
      using _fetch = stub(globalThis, "fetch", () => {
        dispatches.push(c.time.now - start)
        return Promise.resolve(new Response("Upstream unavailable", { status }))
      })
      const pending = request(document)
      await c.time.runAllAsync()
      const response = await pending
      assertEquals(response.status, status)
      assertEquals(await response.text(), "Upstream unavailable")
      assertEquals(dispatches, document === query ? [0, 250, 750] : [0])
      assertEquals(c.time.next(), false)
    })
  }
}

for (const status of [200, 400]) {
  Deno.test(`GraphQL transport recognizes HTTP ${status} RATELIMITED and preserves final envelope`, async () => {
    using c = clock()
    let requests = 0
    const envelope = { data: null, ...rateLimit, extensions: { trace: "last" } }
    using _fetch = stub(globalThis, "fetch", () => {
      requests++
      return Promise.resolve(Response.json(envelope, { status }))
    })
    const pending = request()
    await c.time.runAllAsync()
    const response = await pending
    assertEquals(requests, 3)
    assertEquals(response.status, status)
    assertEquals(await response.json(), envelope)
  })
}

for (const header of ["2", "Tue, 15 Sep 2026 12:00:02 GMT"]) {
  Deno.test(`GraphQL transport honors Retry-After ${header}`, async () => {
    using c = clock()
    const dispatches: number[] = []
    using _fetch = stub(globalThis, "fetch", () => {
      dispatches.push(c.time.now - start)
      return Promise.resolve(
        dispatches.length === 1
          ? Response.json(rateLimit, {
            status: 429,
            headers: { "retry-after": header },
          })
          : Response.json({ data: { viewer: { id: "ok" } } }),
      )
    })
    const pending = request()
    await c.time.tickAsync(1_999)
    assertEquals(dispatches, [0])
    await c.time.tickAsync(1)
    assertEquals(await (await pending).json(), {
      data: { viewer: { id: "ok" } },
    })
    assertEquals(dispatches, [0, 2_000])
    assertEquals(c.time.next(), false)
  })
}

for (
  const header of [
    "60",
    "120",
    "Tue, 15 Sep 2026 12:02:00 GMT",
    "9".repeat(400),
  ]
) {
  Deno.test(`GraphQL transport does not shorten unserviceable Retry-After ${header.slice(0, 40)}`, async () => {
    using c = clock()
    using fetchStub = stub(
      globalThis,
      "fetch",
      () =>
        Promise.resolve(Response.json(rateLimit, {
          status: 429,
          headers: { "retry-after": header },
        })),
    )
    const response = await request()
    assertEquals(await response.json(), rateLimit)
    assertEquals(fetchStub.calls.length, 1)
    assertEquals(c.time.now, start)
    assertEquals(c.time.next(), false)
  })
}

for (const header of ["invalid", "-1", "0", "Tue, 15 Sep 2026 11:00:00 GMT"]) {
  Deno.test(`GraphQL transport uses bounded jitter for Retry-After ${header}`, async () => {
    using c = clock(0.5)
    const dispatches: number[] = []
    using _fetch = stub(globalThis, "fetch", () => {
      dispatches.push(c.time.now - start)
      return Promise.resolve(
        new Response("Busy", {
          status: 503,
          headers: { "retry-after": header },
        }),
      )
    })
    const pending = request()
    await c.time.runAllAsync()
    await (await pending).text()
    assertEquals(dispatches, [0, 375, 1_125])
  })
}

for (
  const test of [
    { query: `${query}\n${mutation}`, operationName: "Read", retry: true },
    { query: `${query}\n${mutation}`, operationName: "Write", retry: false },
    { query: `${query}\n${mutation}`, retry: false },
    { query: `${query}\nquery Other { viewer { name } }`, retry: false },
    { query: `${query}\n${query}`, operationName: "Read", retry: false },
    { query, operationName: "Missing", retry: false },
    { query, operationName: "", retry: false },
    { query: "query Broken {", retry: false },
    { query: "subscription Events { event { id } }", retry: false },
    {
      query:
        '# mutation Fake\nquery Read { search(term: "mutation") { ...Id } } fragment Id on Issue { id }',
      retry: true,
    },
  ]
) {
  Deno.test(`GraphQL transport only replays selected queries: ${JSON.stringify(test)}`, async () => {
    using c = clock()
    using fetchStub = stub(
      globalThis,
      "fetch",
      () => Promise.resolve(new Response("Busy", { status: 503 })),
    )
    const pending = request(test.query, undefined, test.operationName)
    await c.time.runAllAsync()
    await (await pending).text()
    assertEquals(fetchStub.calls.length, test.retry ? 3 : 1)
  })
}

for (
  const test of [
    { status: 401, body: rateLimit },
    { status: 403, body: rateLimit },
    { status: 500, body: rateLimit },
    { status: 400, body: { errors: [{ message: "Invalid query" }] } },
    { status: 200, body: { errors: [{ message: "Resolver failed" }] } },
    {
      status: 429,
      body: {
        errors: [{
          message: "Unauthenticated",
          extensions: { code: "UNAUTHENTICATED" },
        }],
      },
    },
    { status: 503, body: { errors: [{ message: "Validation failed" }] } },
    { status: 200, body: { data: { viewer: null }, ...rateLimit } },
    { status: 503, body: { data: { viewer: null }, ...rateLimit } },
    {
      status: 200,
      body: { errors: [...rateLimit.errors, { message: "Other error" }] },
    },
  ]
) {
  Deno.test(`GraphQL transport does not retry auth/validation/partial data: ${JSON.stringify(test)}`, async () => {
    using c = clock()
    using fetchStub = stub(
      globalThis,
      "fetch",
      () => Promise.resolve(Response.json(test.body, { status: test.status })),
    )
    const response = await request()
    assertEquals(await response.json(), test.body)
    assertEquals(fetchStub.calls.length, 1)
    assertEquals(c.time.next(), false)
  })
}

for (
  const error of [
    new DOMException("fetch timed out", "TimeoutError"),
    new Deno.errors.ConnectionReset("reset"),
    new TypeError("fetch failed", {
      cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }),
    }),
    new TypeError("error sending request: Connection refused (os error 111)"),
    new TypeError("invalid URL"),
    new TypeError("certificate validation failed"),
    new TypeError("Failed to fetch"),
    new Error("unclassified failure"),
  ]
) {
  for (const document of [query, mutation]) {
    Deno.test(`GraphQL transport never guesses retries from ${error.message}: ${document.split(" ")[0]}`, async () => {
      using c = clock()
      using fetchStub = stub(globalThis, "fetch", () => Promise.reject(error))
      const pending = assertRejects(() => request(document))
      await c.time.runAllAsync()
      assertEquals(await pending, error)
      assertEquals(fetchStub.calls.length, 1)
      assertEquals(c.time.next(), false)
    })
  }
}

for (const phase of ["before", "headers", "body", "wait"]) {
  Deno.test(`GraphQL transport preserves earlier caller cancellation during ${phase}`, async () => {
    using c = clock()
    const controller = new AbortController()
    const reason = new DOMException("Caller deadline", "TimeoutError")
    let cancelled = 0
    let attemptSignal: AbortSignal | null | undefined
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled++
      },
    })
    using fetchStub = stub(globalThis, "fetch", (_input, init) => {
      attemptSignal = init?.signal
      if (phase === "headers") return new Promise<Response>(() => {})
      return Promise.resolve(
        phase === "body"
          ? new Response(body)
          : Response.json(rateLimit, { headers: { "retry-after": "20" } }),
      )
    })
    if (phase === "before") controller.abort(reason)
    const pending = assertRejects(() => request(query, controller.signal))
    await c.time.tickAsync(10_000)
    controller.abort(reason)
    assertEquals(await pending, reason)
    assertEquals(fetchStub.calls.length, phase === "before" ? 0 : 1)
    if (phase === "headers" || phase === "body") {
      assertEquals(attemptSignal?.aborted, true)
    }
    assertEquals(cancelled, phase === "body" ? 1 : 0)
    assertEquals(c.time.next(), false)
  })
}

for (const phase of ["headers", "body"]) {
  Deno.test(`GraphQL transport bounds hanging ${phase} at the single total deadline`, async () => {
    using c = clock()
    const dispatches: number[] = []
    const signals: AbortSignal[] = []
    let cancelled = 0
    using _fetch = stub(globalThis, "fetch", (_input, init) => {
      dispatches.push(c.time.now - start)
      signals.push(init!.signal!)
      if (phase === "headers") return new Promise<Response>(() => {})
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"data":'))
            },
            cancel() {
              cancelled++
              // A pending cancellation must not extend the request deadline.
              return new Promise<void>(() => {})
            },
          }),
        ),
      )
    })
    const pending = assertRejects(() => request(), DOMException, "timed out")
    await c.time.tickAsync(59_999)
    assertEquals(signals.map((signal) => signal.aborted), [false])
    assertEquals(cancelled, 0)
    await c.time.tickAsync(1)
    assertEquals((await pending).name, "TimeoutError")
    assertEquals(dispatches, [0])
    assertEquals(c.time.now - start, 60_000)
    assertEquals(signals.map((signal) => signal.aborted), [true])
    assertEquals(cancelled, phase === "body" ? 1 : 0)
    assertEquals(c.time.next(), false)
  })
}

Deno.test("GraphQL transport counts completed attempt bodies and Retry-After against total deadline", async () => {
  using c = clock()
  const dispatches: number[] = []
  let cancelled = 0
  using _fetch = stub(globalThis, "fetch", () => {
    dispatches.push(c.time.now - start)
    const first = dispatches.length === 1
    return Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            if (first) {
              setTimeout(() => {
                controller.enqueue(
                  new TextEncoder().encode(JSON.stringify(rateLimit)),
                )
                controller.close()
              }, 20_000)
            }
          },
          cancel() {
            cancelled++
          },
        }),
        { status: 429, headers: { "retry-after": "20" } },
      ),
    )
  })
  const pending = assertRejects(() => request(), DOMException, "timed out")
  await c.time.runAllAsync()
  await pending
  assertEquals(dispatches, [0, 40_000])
  assertEquals(c.time.now - start, 60_000)
  assertEquals(cancelled, 1)
})

for (const status of [200, 429]) {
  Deno.test(`GraphQL transport preserves a complete HTTP ${status} response at the total deadline`, async () => {
    using time = new FakeTime(start)
    let elapsedAfterEof = 0
    using _now = stub(performance, "now", () => time.now + elapsedAfterEof)
    let requests = 0
    const envelope = status === 200
      ? { data: { viewer: { id: "ok" } } }
      : rateLimit
    const decode = TextDecoder.prototype.decode
    using _decode = stub(TextDecoder.prototype, "decode", function (
      this: TextDecoder,
      ...args: Parameters<TextDecoder["decode"]>
    ) {
      const text = decode.apply(this, args)
      // Model synchronous EOF cleanup crossing the last millisecond of budget,
      // before the event loop can deliver a timer callback.
      if (requests === 2 && args[0] == null) elapsedAfterEof = 1
      return text
    })
    using _fetch = stub(globalThis, "fetch", () => {
      requests++
      return Promise.resolve(
        requests === 1
          ? new Response("Unavailable", {
            status: 503,
            headers: { "retry-after": "59" },
          })
          : new Response(
            new ReadableStream({
              start(controller) {
                setTimeout(() => {
                  controller.enqueue(
                    new TextEncoder().encode(JSON.stringify(envelope)),
                  )
                  controller.close()
                }, 999)
              },
            }),
            { status },
          ),
      )
    })
    const pending = request().then(
      (response) => ({ response }),
      (error: unknown) => ({ error }),
    )
    await time.runAllAsync()
    const result = await pending
    if ("error" in result) throw result.error
    const { response } = result
    assertEquals(response.status, status)
    assertEquals(await response.json(), envelope)
    assertEquals(requests, 2)
    assertEquals(time.next(), false)
  })
}

Deno.test("GraphQL transport cancels a response arriving after header timeout", async () => {
  using c = clock()
  let resolve: (response: Response) => void = () => {}
  let cancelled = 0
  using _fetch = stub(
    globalThis,
    "fetch",
    () => new Promise<Response>((r) => resolve = r),
  )
  const pending = assertRejects(() => request(mutation), DOMException)
  await c.time.runAllAsync()
  await pending
  resolve(
    new Response(
      new ReadableStream({
        cancel() {
          cancelled++
        },
      }),
    ),
  )
  await c.time.runMicrotasks()
  assertEquals(cancelled, 1)
  assertEquals(c.time.next(), false)
})

for (const status of [400, 401, 403, 429, 503]) {
  Deno.test(`GraphQL transport retains HTTP ${status} constraints after body interruption`, async () => {
    using c = clock()
    const failure = new Deno.errors.ConnectionReset("body reset")
    using fetchStub = stub(
      globalThis,
      "fetch",
      () =>
        Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                controller.error(failure)
              },
            }),
            { status, headers: { "retry-after": "120" } },
          ),
        ),
    )
    assertEquals(await assertRejects(() => request()), failure)
    assertEquals(fetchStub.calls.length, 1)
    assertEquals(c.time.next(), false)
  })
}

for (const status of [200, 400, 401, 429, 502, 503, 504]) {
  Deno.test(`GraphQL transport never retries interrupted HTTP ${status} bodies`, async () => {
    using c = clock()
    let requests = 0
    const failure = new Deno.errors.ConnectionReset("body reset")
    using _fetch = stub(globalThis, "fetch", () => {
      requests++
      return Promise.resolve(
        requests === 1
          ? new Response(
            new ReadableStream({
              start(controller) {
                controller.error(failure)
              },
            }),
            { status },
          )
          : Response.json({ data: { viewer: { id: "ok" } } }),
      )
    })
    assertEquals(await assertRejects(() => request()), failure)
    assertEquals(requests, 1)
    assertEquals(c.time.next(), false)
  })
}

for (const phase of ["headers", "body"]) {
  for (const document of [query, mutation]) {
    Deno.test(`GraphQL transport accepts ${phase} after 30 seconds: ${document.split(" ")[0]}`, async () => {
      using c = clock()
      const envelope = { data: { id: "completed" } }
      using fetchStub = stub(globalThis, "fetch", () => {
        if (phase === "headers") {
          return new Promise<Response>((resolve) => {
            setTimeout(() => resolve(Response.json(envelope)), 45_000)
          })
        }
        return Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                setTimeout(() => {
                  controller.enqueue(
                    new TextEncoder().encode(JSON.stringify(envelope)),
                  )
                  controller.close()
                }, 45_000)
              },
            }),
          ),
        )
      })
      const pending = request(document)
      await c.time.runAllAsync()
      assertEquals(await (await pending).json(), envelope)
      assertEquals(fetchStub.calls.length, 1)
      assertEquals(c.time.now - start, 45_000)
      assertEquals(c.time.next(), false)
    })
  }
}
