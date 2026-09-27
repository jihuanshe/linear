/**
 * Mock Linear API server for testing
 *
 * Usage:
 * const server = new MockLinearServer([
 *   {
 *     queryName: "GetIssueDetails",
 *     variables: { id: "TEST-123" },
 *     response: { data: { issue: { title: "Test Issue", ... } } }
 *   }
 * ]);
 */

export interface MockGraphQLRequest {
  query: string
  variables: Record<string, unknown>
}

interface MockResponse {
  queryName: string
  queryIncludes?: string
  variables?: Record<string, unknown>
  response:
    | Record<string, unknown>
    | ((
      request: MockGraphQLRequest,
      history: readonly MockGraphQLRequest[],
    ) => Record<string, unknown> | Promise<Record<string, unknown>>)
  status?: number
  /** Extra response headers, e.g. Linear's `x-ratelimit-*`. */
  headers?: Record<string, string>
}

export interface UploadRequest {
  pathname: string
  contentType: string | null
  headers: Record<string, string>
  body: Uint8Array
}

export class MockLinearServer {
  private server?: Deno.HttpServer
  private port = 0
  private mockResponses: MockResponse[]
  /** Signed-URL file uploads received via PUT, in arrival order */
  readonly uploadRequests: UploadRequest[] = []
  /** GraphQL requests received, in arrival order. */
  readonly graphqlRequests: MockGraphQLRequest[] = []

  constructor(responses: MockResponse[] = []) {
    this.mockResponses = responses
  }

  start(): void {
    this.server = Deno.serve({
      hostname: "127.0.0.1",
      port: this.port,
      onListen: () => {},
    }, (request) => {
      // Handle CORS preflight
      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 200,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization",
          },
        })
      }

      // Handle GraphQL requests
      if (
        request.method === "POST" &&
        new URL(request.url).pathname === "/graphql"
      ) {
        return this.handleGraphQL(request)
      }

      // Handle signed-URL file uploads (the PUT step of the fileUpload flow)
      if (
        request.method === "PUT" &&
        new URL(request.url).pathname.startsWith("/upload")
      ) {
        return this.handleUpload(request)
      }

      return new Response("Not Found", { status: 404 })
    })

    if ("port" in this.server.addr) {
      this.port = this.server.addr.port
    }

    // Deno.serve has synchronously bound the port before returning. There is
    // no need to add a fixed delay to every test fixture.
  }

  async stop(): Promise<void> {
    if (this.server) {
      await this.server.shutdown()
      this.server = undefined
    }
  }

  getEndpoint(): string {
    return `http://localhost:${this.port}/graphql`
  }

  /** URL to hand out as a fileUpload signed uploadUrl in mock responses */
  getUploadUrl(): string {
    return `http://localhost:${this.port}/upload`
  }

  private async handleUpload(request: Request): Promise<Response> {
    const headers: Record<string, string> = {}
    for (const [key, value] of request.headers) {
      headers[key] = value
    }
    this.uploadRequests.push({
      pathname: new URL(request.url).pathname,
      contentType: request.headers.get("content-type"),
      headers,
      body: new Uint8Array(await request.arrayBuffer()),
    })
    return new Response(null, { status: 200 })
  }

  private async handleGraphQL(request: Request): Promise<Response> {
    const headers = {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      // Use fixed date header for deterministic snapshot tests
      "Date": "Mon, 01 Jan 2024 00:00:00 GMT",
    }

    try {
      const body = await request.json()
      const { query, variables } = body
      this.graphqlRequests.push({ query, variables: variables ?? {} })

      // Find matching mock response
      const mockResponse = this.findMatchingResponse(query, variables)

      if (mockResponse) {
        const response = typeof mockResponse.response === "function"
          ? await mockResponse.response(
            { query, variables: variables ?? {} },
            this.graphqlRequests,
          )
          : mockResponse.response
        return new Response(
          JSON.stringify(
            withExistingFilterReferences(response, variables ?? {}),
          ),
          {
            status: mockResponse.status ?? 200,
            headers: { ...headers, ...mockResponse.headers },
          },
        )
      }

      // Default response for unhandled queries
      return new Response(
        JSON.stringify({
          errors: [{
            message: "No mock response configured for this query",
            extensions: {
              code: "NO_MOCK_CONFIGURED",
              query: this.extractQueryName(query),
              variables,
            },
          }],
        }),
        { status: 200, headers },
      )
    } catch (_error) {
      return new Response(
        JSON.stringify({
          errors: [{
            message: "Invalid JSON in request body",
            extensions: { code: "BAD_REQUEST" },
          }],
        }),
        { status: 400, headers },
      )
    }
  }

  private findMatchingResponse(
    query: string,
    variables: Record<string, unknown> = {},
  ): MockResponse | undefined {
    const queryName = this.extractQueryName(query)

    return this.mockResponses.find((mock) => {
      // Check if query name matches
      if (mock.queryName !== queryName) {
        return false
      }

      if (mock.queryIncludes != null && !query.includes(mock.queryIncludes)) {
        return false
      }

      // If no variables specified in mock, match any variables
      if (!mock.variables) {
        return true
      }

      // Check if all mock variables match the request variables (deep comparison)
      return Object.entries(mock.variables).every(([key, value]) => {
        return this.deepEqual(variables[key], value)
      })
    })
  }

  private deepEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true
    if (a == null || b == null) return a === b
    if (typeof a !== typeof b) return false
    if (typeof a !== "object") return a === b

    const aObj = a as Record<string, unknown>
    const bObj = b as Record<string, unknown>
    const aKeys = Object.keys(aObj)
    const bKeys = Object.keys(bObj)

    if (aKeys.length !== bKeys.length) return false

    return aKeys.every((key) => this.deepEqual(aObj[key], bObj[key]))
  }

  private extractQueryName(query: string): string {
    // Extract query name from GraphQL query string
    // Examples: "query GetIssueDetails" -> "GetIssueDetails"
    const match = query.match(/(?:query|mutation)\s+(\w+)/)
    return match?.[1] || "UnknownQuery"
  }

  addResponse(response: MockResponse): void {
    this.mockResponses.push(response)
  }

  clearResponses(): void {
    this.mockResponses = []
  }
}

/** Alias, flag variable, filter variable and node field of each check. */
const FILTER_REFERENCE_CHECKS = [
  ["referenceTeams", "checkTeamReferences", "teamReferenceFilter", "key"],
  [
    "referenceWorkflowStates",
    "checkWorkflowStateReferences",
    "workflowStateReferenceFilter",
    "name",
  ],
  [
    "referenceIssueLabels",
    "checkIssueLabelReferences",
    "issueLabelReferenceFilter",
    "name",
  ],
  [
    "referenceProjectLabels",
    "checkProjectLabelReferences",
    "projectLabelReferenceFilter",
    "name",
  ],
  [
    "referenceProjects",
    "checkProjectReferences",
    "projectReferenceFilter",
    "id",
  ],
  [
    "referenceMilestones",
    "checkMilestoneReferences",
    "milestoneReferenceFilter",
    "id",
  ],
] as const

function filterValues(filter: unknown, field: string): string[] {
  if (filter == null || typeof filter !== "object") return []
  const record = filter as Record<string, unknown>
  if (Array.isArray(record.or)) {
    return record.or.flatMap((clause) => filterValues(clause, field))
  }
  const comparator = record[field] as Record<string, unknown> | undefined
  if (comparator == null) return []
  if (Array.isArray(comparator.in)) return comparator.in as string[]
  const value = comparator.eqIgnoreCase ?? comparator.eq
  return typeof value === "string" ? [value] : []
}

/**
 * Like Linear, answer the filter reference checks a request asked for. Unless
 * a mock sets the alias itself, every requested value exists, so only tests
 * about missing values have to describe the checks.
 */
function withExistingFilterReferences(
  response: Record<string, unknown>,
  variables: Record<string, unknown>,
): Record<string, unknown> {
  const data = response.data
  if (data == null || typeof data !== "object") return response
  const filled: Record<string, unknown> = { ...data }
  for (const [alias, flag, filter, field] of FILTER_REFERENCE_CHECKS) {
    if (variables[flag] !== true || alias in filled) continue
    filled[alias] = {
      nodes: filterValues(variables[filter], field).map((value) => ({
        [field]: value,
      })),
      pageInfo: { hasNextPage: false },
    }
  }
  return { ...response, data: filled }
}
