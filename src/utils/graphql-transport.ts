import { Kind, type OperationTypeNode, parse } from "graphql"

// Internal, reversible defaults, not a CLI configuration surface. Each logical
// request (one pagination page) includes headers, body consumption and waits.
const attemptTimeoutMs = 30_000
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

function transientNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (
    error instanceof DOMException && error.name === "TimeoutError" ||
    error instanceof Deno.errors.ConnectionReset ||
    error instanceof Deno.errors.ConnectionRefused ||
    error instanceof Deno.errors.ConnectionAborted ||
    error instanceof Deno.errors.TimedOut ||
    error instanceof Deno.errors.UnexpectedEof ||
    error instanceof Deno.errors.BrokenPipe
  ) return true
  const codes = new Set([
    "ECONNRESET",
    "ECONNREFUSED",
    "ECONNABORTED",
    "ETIMEDOUT",
    "EPIPE",
    "EAI_AGAIN",
    "ENETUNREACH",
    "EHOSTUNREACH",
  ])
  // Fetch can wrap OS failures. Do not retry generic TypeErrors (invalid URL,
  // TLS/configuration errors, etc.) or a caller's AbortError.
  let cause: unknown = error
  for (let depth = 0; depth < 4 && cause instanceof Error; depth++) {
    if ("code" in cause && codes.has(String(cause.code))) return true
    if (
      cause instanceof TypeError &&
      /\b(connection reset|connection refused|connection closed before message completed|broken pipe|temporary failure in name resolution|network is unreachable|connect(?:ion)? timed out)\b/i
        .test(cause.message)
    ) return true
    cause = cause.cause
  }
  return false
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
    let result: { response: Response; text: string } | undefined
    let response: Response | undefined
    let failure: unknown
    {
      using current = deadline(
        overall.signal,
        Math.min(attemptTimeoutMs, end - performance.now()),
      )
      try {
        const pending = fetch(input, { ...init, signal: current.signal })
        // Even a fetch implementation that resolves after cancellation must not
        // leave an unread response body behind.
        void pending.then((response) => {
          if (current.signal.aborted) {
            void response.body?.cancel().catch(() => {})
          }
        }, () => {})
        response = await abortable(pending, current.signal)
        result = { response, text: await readBody(response, current.signal) }
        current.signal.throwIfAborted()
      } catch (error) {
        result = undefined
        failure = error
      }
    }
    // Once the body is complete, preserve it even if synchronous cleanup
    // crossed the deadline. An exhausted budget still prevents another retry.
    if (result == null) checkDeadline()
    const retry = query && attempt < maxAttempts &&
      (result
        ? retryableResponse(result.response, result.text)
        : transientNetworkError(failure) &&
          (response == null || response.status === 200 ||
            retryStatuses.has(response.status)))
    const backoff = Math.ceil(
      Math.min(5_000, 500 * 2 ** (attempt - 1)) * (0.5 + Math.random() * 0.5),
    )
    // Headers still constrain retry when the response body was interrupted.
    const wait = Math.max(
      backoff,
      response ? retryAfter(response) ?? 0 : 0,
    )
    if (!retry || wait >= end - performance.now()) {
      if (!result) throw failure
      return new Response(result.response.body == null ? null : result.text, {
        status: result.response.status,
        statusText: result.response.statusText,
        headers: result.response.headers,
      })
    }
    // Do not clamp Retry-After to the remaining budget and hammer the server.
    // If it cannot be honored, the original response/failure is surfaced above.
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
