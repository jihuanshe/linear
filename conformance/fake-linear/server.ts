/**
 * HTTP front end of the fake Linear API.
 *
 * Requests are validated against Linear's published schema and executed
 * against the in-memory store. The request log records operation types and
 * root fields: the public API surface, not the client's operation names.
 * Fault rules let a case break the transport around a matching request.
 */
import {
  buildSchema,
  execute,
  type GraphQLError,
  type GraphQLSchema,
  Kind,
  type OperationDefinitionNode,
  parse,
  validate,
} from "graphql"
import { type Context, fieldResolver, typeResolver } from "./resolve.ts"
import { rootValue } from "./root.ts"
import { LinearError } from "./errors.ts"
import type { Seed, Store } from "./store.ts"

export const API_KEY = "lin_api_conformance"

let schemaCache: GraphQLSchema | undefined
export function linearSchema(): GraphQLSchema {
  schemaCache ??= buildSchema(
    Deno.readTextFileSync(
      new URL("../../graphql/schema.graphql", import.meta.url),
    ),
  )
  return schemaCache
}

export interface LoggedRequest {
  operation: "query" | "mutation" | "invalid"
  fields: string[]
  variables: Record<string, unknown>
  status: number
}

/**
 * A transport fault applied to the nth request matching `on`
 * (`query`, `mutation`, `mutation:issueUpdate`, ...).
 */
export interface FaultRule {
  on: string
  nth?: number
  times?: number
  /**
   * `status` returns `status`/`body` without executing.
   * `drop-before` closes the connection without executing.
   * `drop-after` executes, then closes the connection without a response.
   * `stall` executes, sends headers and part of the body, then stalls.
   */
  action: "status" | "drop-before" | "drop-after" | "stall"
  status?: number
  body?: unknown
  headers?: Record<string, string>
}

export class FakeLinear {
  readonly requests: LoggedRequest[] = []
  readonly gaps: string[] = []
  faults: FaultRule[] = []
  #seen = new Map<FaultRule, number>()
  #server?: Deno.HttpServer
  #stalls = new Set<ReadableStreamDefaultController<Uint8Array>>()

  constructor(readonly store: Store) {}

  get endpoint(): string {
    const addr = this.#server?.addr as Deno.NetAddr
    return `http://127.0.0.1:${addr.port}/graphql`
  }

  start(): void {
    this.#server = Deno.serve(
      {
        hostname: "127.0.0.1",
        port: 0,
        onListen: () => {},
        // Injected connection drops surface here; they are intended.
        onError: () => new Response(null, { status: 500 }),
      },
      (request) => this.#handle(request),
    )
  }

  async stop(): Promise<void> {
    for (const controller of this.#stalls) {
      try {
        controller.error(new Error("stopped"))
      } catch { /* already closed */ }
    }
    await this.#server?.shutdown()
  }

  mutationCounts(since = 0): Record<string, number> {
    const counts: Record<string, number> = {}
    for (const request of this.requests.slice(since)) {
      if (request.operation !== "mutation") continue
      for (const field of request.fields) {
        counts[field] = (counts[field] ?? 0) + 1
      }
    }
    return counts
  }

  snapshot(): Seed {
    return this.store.snapshot()
  }

  #fault(operation: string, fields: string[]): FaultRule | undefined {
    for (const rule of this.faults) {
      const [kind, field] = rule.on.split(":")
      if (kind !== operation || (field != null && !fields.includes(field))) {
        continue
      }
      const seen = (this.#seen.get(rule) ?? 0) + 1
      this.#seen.set(rule, seen)
      const nth = rule.nth ?? 1
      if (seen >= nth && seen < nth + (rule.times ?? 1)) return rule
    }
    return undefined
  }

  async #handle(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (request.method !== "POST" || url.pathname !== "/graphql") {
      return new Response("Not Found", { status: 404 })
    }
    if (request.headers.get("authorization") !== API_KEY) {
      return json(401, {
        errors: [{
          message: "Authentication required, not authenticated",
          extensions: {
            type: "authentication error",
            code: "AUTHENTICATION_ERROR",
            statusCode: 401,
            userError: true,
            userPresentableMessage:
              "You need to authenticate to access this operation.",
          },
        }],
      })
    }
    const body = await request.json() as {
      query: string
      variables?: Record<string, unknown>
      operationName?: string
    }
    const variables = body.variables ?? {}
    const schema = linearSchema()
    let document
    try {
      document = parse(body.query)
    } catch (error) {
      return this.#log(
        "invalid",
        [],
        variables,
        json(400, {
          errors: [{
            message: (error as Error).message,
            extensions: { code: "GRAPHQL_PARSE_FAILED", type: "graphql error" },
          }],
        }),
      )
    }
    const validation = validate(schema, document)
    if (validation.length > 0) {
      return this.#log(
        "invalid",
        [],
        variables,
        json(400, {
          errors: validation.map((error) => ({
            message: error.message,
            locations: error.locations,
            extensions: {
              code: "GRAPHQL_VALIDATION_FAILED",
              type: "graphql error",
              userError: true,
            },
          })),
        }),
      )
    }
    const operation = document.definitions.find((
      definition,
    ): definition is OperationDefinitionNode =>
      definition.kind === Kind.OPERATION_DEFINITION &&
      (body.operationName == null ||
        definition.name?.value === body.operationName)
    )
    const kind = operation?.operation === "mutation" ? "mutation" : "query"
    const fields =
      operation?.selectionSet.selections.flatMap((selection) =>
        selection.kind === Kind.FIELD ? [selection.name.value] : []
      ) ?? []

    const fault = this.#fault(kind, fields)
    if (fault?.action === "status") {
      return this.#log(
        kind,
        fields,
        variables,
        json(fault.status ?? 500, fault.body ?? {}, fault.headers),
      )
    }
    if (fault?.action === "drop-before") {
      return this.#log(kind, fields, variables, dropped())
    }

    const ctx: Context = { store: this.store, schema }
    const result = await execute({
      schema,
      document,
      variableValues: variables,
      operationName: body.operationName,
      contextValue: ctx,
      rootValue: rootValue(),
      fieldResolver,
      typeResolver,
    })
    const errors = (result as { errors?: readonly GraphQLError[] }).errors ?? []
    for (const error of errors) {
      if (!(error.originalError instanceof LinearError)) {
        this.gaps.push(error.message)
      }
    }
    if (errors.some((error) => !(error.originalError instanceof LinearError))) {
      return this.#log(
        kind,
        fields,
        variables,
        json(500, {
          errors: errors.map((error) => ({
            message: `fake-linear: ${error.message}`,
          })),
        }),
      )
    }

    if (fault?.action === "drop-after") {
      return this.#log(kind, fields, variables, dropped())
    }
    const payload = {
      ...(result as object),
      errors: errors.length > 0
        ? errors.map((error) => ({
          message: error.message,
          path: error.path,
          locations: error.locations,
          extensions: error.extensions,
        }))
        : undefined,
    }
    if (fault?.action === "stall") {
      const text = JSON.stringify(payload)
      const stream = new ReadableStream<Uint8Array>({
        start: (controller) => {
          this.#stalls.add(controller)
          controller.enqueue(new TextEncoder().encode(text.slice(0, 8)))
        },
      })
      return this.#log(
        kind,
        fields,
        variables,
        new Response(stream, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
    }
    return this.#log(kind, fields, variables, json(200, payload))
  }

  #log(
    operation: LoggedRequest["operation"],
    fields: string[],
    variables: Record<string, unknown>,
    response: Response,
  ): Response {
    this.requests.push({
      operation,
      fields,
      variables,
      status: response.status,
    })
    return response
  }
}

/** Headers arrive, then the connection fails before a complete body. */
function dropped(): Response {
  const stream = new ReadableStream<Uint8Array>({
    start: (controller) => controller.error(new Error("connection dropped")),
  })
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}

function json(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  })
}
