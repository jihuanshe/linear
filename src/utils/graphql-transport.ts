import { Kind, type OperationTypeNode, parse } from "graphql"

// Internal, reversible defaults, not a CLI configuration surface. Each logical
// request (one pagination page) includes headers, body consumption and waits.
const requestTimeoutMs = 60_000
const maxAttempts = 3
const retryStatuses = new Set([429, 502, 503, 504])

/** Only an unambiguously selected JSON GraphQL operation is safe to classify. */
export function graphQLOperation(
  body: BodyInit | null | undefined,
): OperationTypeNode | undefined {
  if (typeof body !== "string") return undefined
  try {
    const request: unknown = JSON.parse(body)
    if (!isRecord(request) || typeof request.query !== "string") {
      return undefined
    }
    if (
      request.operationName != null &&
      typeof request.operationName !== "string"
    ) return undefined
    const operations = parse(request.query).definitions.filter((definition) =>
      definition.kind === Kind.OPERATION_DEFINITION &&
      (request.operationName == null ||
        definition.name?.value === request.operationName)
    )
    return operations.length === 1 &&
        operations[0]?.kind === Kind.OPERATION_DEFINITION
      ? operations[0].operation
      : undefined
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value)
}

function retryableResponse(response: Response, text: string): boolean {
  if (
    !retryStatuses.has(response.status) && response.status !== 200 &&
    response.status !== 400
  ) return false
  let envelope: unknown
  try {
    envelope = JSON.parse(text)
  } catch {
    return retryStatuses.has(response.status)
  }
  if (isRecord(envelope)) {
    // Never discard partial data, or reinterpret auth/validation/resolver errors
    // as overload just because a proxy attached a retryable HTTP status.
    if (envelope.data != null) return false
    if ("errors" in envelope) {
      return Array.isArray(envelope.errors) && envelope.errors.length > 0 &&
        envelope.errors.every((error: unknown) =>
          isRecord(error) && typeof error.message === "string" &&
          isRecord(error.extensions) && error.extensions.code === "RATELIMITED"
        )
    }
  }
  return retryStatuses.has(response.status)
}

function retryAfter(response: Response): number | undefined {
  const value = response.headers.get("retry-after")?.trim()
  if (!value) return undefined
  if (/^\d+$/.test(value)) return Number(value) * 1_000
  // Date.parse accepts bare numbers as dates; those are not HTTP-date values.
  if (!/[a-z]/i.test(value)) return undefined
  const date = Date.parse(value)
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now())
}

function timeout(message: string): DOMException {
  return new DOMException(message, "TimeoutError")
}

function deadline(parent: AbortSignal | null | undefined, ms: number) {
  const controller = new AbortController()
  const abort = () => controller.abort(parent?.reason)
  if (parent?.aborted) abort()
  else parent?.addEventListener("abort", abort, { once: true })
  const timer = setTimeout(
    () => controller.abort(timeout("GraphQL request timed out")),
    ms,
  )
  return {
    signal: controller.signal,
    [Symbol.dispose]() {
      clearTimeout(timer)
      parent?.removeEventListener("abort", abort)
    },
  }
}

async function abortable<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  let abort: () => void = () => {}
  const interrupted = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason)
    if (signal.aborted) abort()
    else signal.addEventListener("abort", abort, { once: true })
  })
  try {
    return await Promise.race([promise, interrupted])
  } finally {
    signal.removeEventListener("abort", abort)
  }
}

async function readBody(
  response: Response,
  signal: AbortSignal,
): Promise<string> {
  if (!response.body) return ""
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let text = ""
  try {
    while (true) {
      signal.throwIfAborted()
      const { done, value } = await abortable(reader.read(), signal)
      if (done) return text + decoder.decode()
      text += decoder.decode(value, { stream: true })
    }
  } finally {
    // Cancellation itself may hang in an upstream stream. Do not extend the
    // request deadline while waiting for cleanup.
    void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

/** Fetch-compatible transport; returns a fully buffered, unchanged envelope. */
export async function graphqlFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  // Request objects and non-string bodies cannot be replayed safely here.
  const query = !(input instanceof Request) &&
    graphQLOperation(init?.body) === "query"
  const parent = init?.signal ??
    (input instanceof Request ? input.signal : null)
  using overall = deadline(parent, requestTimeoutMs)
  const end = performance.now() + requestTimeoutMs
  const checkDeadline = () => {
    overall.signal.throwIfAborted()
    if (performance.now() >= end) throw timeout("GraphQL request timed out")
  }

  for (let attempt = 1;; attempt++) {
    checkDeadline()
    const pending = fetch(input, { ...init, signal: overall.signal })
    // Even a fetch implementation that resolves after cancellation must not
    // leave an unread response body behind.
    void pending.then((response) => {
      if (overall.signal.aborted) {
        void response.body?.cancel().catch(() => {})
      }
    }, () => {})
    const response = await abortable(pending, overall.signal)
    const text = await readBody(response, overall.signal)
    overall.signal.throwIfAborted()
    // Once the body is complete, preserve it even if synchronous cleanup
    // crossed the deadline. An exhausted budget still prevents another retry.
    const retry = query && attempt < maxAttempts &&
      retryableResponse(response, text)
    const backoff = Math.ceil(
      Math.min(5_000, 500 * 2 ** (attempt - 1)) * (0.5 + Math.random() * 0.5),
    )
    const wait = Math.max(backoff, retryAfter(response) ?? 0)
    if (!retry || wait >= end - performance.now()) {
      return new Response(response.body == null ? null : text, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      })
    }
    // Do not clamp Retry-After to the remaining budget and hammer the server.
    // If it cannot be honored, the original response is surfaced above.
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await abortable(
        new Promise<void>((resolve) => timer = setTimeout(resolve, wait)),
        overall.signal,
      )
    } finally {
      clearTimeout(timer)
    }
  }
}
