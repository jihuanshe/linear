import { assertEquals, assertMatch, assertNotMatch } from "@std/assert"
import { fromFileUrl } from "@std/path"

const main = fromFileUrl(new URL("../../../src/main.ts", import.meta.url))
const config = fromFileUrl(new URL("../../../deno.json", import.meta.url))
const decoder = new TextDecoder()

// Exercise the production process, including exits and signals. Only redirect
// the fixed OAuth origin; production has no configurable secret destination.
async function fixture(
  options: {
    tokenStatus?: number
    tokenType?: string
    accessToken?: string
    graphqlFailure?: boolean
    revokeStatus?: number
    alreadyRevoked?: boolean
    pause?: "token" | "graphql" | "revoke"
  },
  action: (f: {
    run: (args: string[], env?: Record<string, string>) => Deno.ChildProcess
    requests: { path: string; authorization: string | null; body: string }[]
    reached: Promise<void>
    release: () => void
  }) => Promise<void>,
) {
  const root = await Deno.makeTempDir()
  const requests: {
    path: string
    authorization: string | null
    body: string
  }[] = []
  const reached = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    async (request) => {
      const path = new URL(request.url).pathname
      requests.push({
        path,
        authorization: request.headers.get("authorization"),
        body: await request.text(),
      })
      if (
        path ===
          `/${
            options.pause === "graphql" ? "graphql" : `oauth/${options.pause}`
          }`
      ) {
        reached.resolve()
        await release.promise
      }
      if (path === "/oauth/token") {
        return Response.json(
          options.tokenStatus ? { error: "client-secret access-token" } : {
            access_token: options.accessToken ?? "access-token",
            token_type: options.tokenType ?? "Bearer",
            scope: "read",
            expires_in: 2591999,
          },
          { status: options.tokenStatus ?? 200 },
        )
      }
      if (path === "/oauth/revoke") {
        return Response.json(
          options.revokeStatus
            ? {
              error: options.alreadyRevoked
                ? "Token has already been revoked."
                : "client-secret access-token",
            }
            : { success: true },
          {
            status: options.revokeStatus ?? 200,
          },
        )
      }
      return Response.json(
        options.graphqlFailure ? { errors: [{ message: "Denied" }] } : {
          data: {
            viewer: {
              id: "app-user",
              name: "Review Bot",
              app: true,
              organization: { id: "org", name: "Acme", urlKey: "acme" },
            },
          },
        },
      )
    },
  )
  const origin = `http://127.0.0.1:${server.addr.port}`
  const preload = `${root}/fetch.ts`
  await Deno.writeTextFile(
    preload,
    `
const original = globalThis.fetch
globalThis.fetch = (input, init) => {
  const url = String(input)
  return original(url.startsWith("https://api.linear.app/oauth/")
    ? url.replace("https://api.linear.app", ${
      JSON.stringify(origin)
    }) : input, init)
}
`,
  )
  const { denoDir } = JSON.parse(
    decoder.decode(
      (await new Deno.Command(Deno.execPath(), {
        args: ["info", "--json"],
        stdout: "piped",
      }).output()).stdout,
    ),
  ) as { denoDir: string }
  try {
    await action({
      run: (args, env = {}) =>
        new Deno.Command(Deno.execPath(), {
          args: [
            "run",
            "--allow-all",
            "--quiet",
            "--config",
            config,
            `--preload=${preload}`,
            main,
            ...args,
          ],
          cwd: root,
          clearEnv: true,
          env: {
            HOME: root,
            XDG_CONFIG_HOME: root,
            APPDATA: root,
            PATH: Deno.env.get("PATH") ?? "",
            DENO_DIR: denoDir,
            SystemRoot: Deno.env.get("SystemRoot") ?? "",
            LINEAR_CLIENT_ID: "client-id",
            LINEAR_CLIENT_SECRET: "client-secret",
            LINEAR_GRAPHQL_ENDPOINT: `${origin}/graphql`,
            LINEAR_DEBUG: "1",
            ...env,
          },
          stdin: "null",
          stdout: "piped",
          stderr: "piped",
        }).spawn(),
      requests,
      reached: reached.promise,
      release: () => release.resolve(),
    })
  } finally {
    release.resolve()
    await server.shutdown()
    await Deno.remove(root, { recursive: true })
  }
}

function noSecrets(result: Deno.CommandOutput) {
  assertNotMatch(
    decoder.decode(result.stdout) + decoder.decode(result.stderr),
    /client-secret|access-token/,
  )
}

Deno.test("client credentials authenticate typed and raw commands and revoke on success or failure", async () => {
  for (const raw of [false, true]) {
    for (const graphqlFailure of [false, true]) {
      await fixture({ graphqlFailure }, async ({ run, requests }) => {
        const result = await run(
          raw
            ? ["api", "query { viewer { id } }"]
            : ["auth", "whoami", "--json"],
        ).output()
        noSecrets(result)
        assertEquals(
          result.code,
          graphqlFailure ? 1 : 0,
          decoder.decode(result.stderr),
        )
        if (!graphqlFailure) {
          const json = JSON.parse(decoder.decode(result.stdout))
          assertEquals(
            raw ? json.data.viewer.app : json.app,
            true,
          )
        } else assertMatch(decoder.decode(result.stdout), /Denied/)
        assertEquals(requests.map((r) => r.path), [
          "/oauth/token",
          "/graphql",
          "/oauth/revoke",
        ])
        assertEquals(
          Object.fromEntries(new URLSearchParams(requests[0]!.body)),
          {
            client_id: "client-id",
            client_secret: "client-secret",
            grant_type: "client_credentials",
            scope: "read",
          },
        )
        assertEquals(requests[1]!.authorization, "Bearer access-token")
        assertEquals(
          Object.fromEntries(new URLSearchParams(requests[2]!.body)),
          {
            token: "access-token",
            token_type_hint: "access_token",
          },
        )
        assertEquals(requests[2]!.authorization, null)
      })
    }
  }
})

Deno.test("client credentials fail closed and never expose OAuth response bodies or auth key", async () => {
  for (
    const scenario of [
      "token",
      "type",
      "header",
      "revoke",
      "revoked400",
      "revoked401",
      "denied401",
      "partial",
      "scope",
      "emptyScope",
      "workspace",
      "key",
      "precedence",
      "help",
    ] as const
  ) {
    await fixture({
      tokenStatus: scenario === "token" ? 401 : undefined,
      tokenType: scenario === "type" ? "invalid" : undefined,
      accessToken: scenario === "header"
        ? "access-token\r\ninvalid"
        : undefined,
      revokeStatus: scenario === "revoke"
        ? 503
        : scenario === "revoked400"
        ? 400
        : ["revoked401", "denied401"].includes(scenario)
        ? 401
        : undefined,
      alreadyRevoked: ["revoked400", "revoked401"].includes(scenario),
    }, async ({ run, requests }) => {
      const result = await run(
        scenario === "key"
          ? ["auth", "key"]
          : scenario === "help"
          ? ["--help"]
          : [
            "auth",
            "whoami",
            "--json",
            ...(scenario === "workspace" ? ["--workspace", "acme"] : []),
          ],
        scenario === "partial"
          ? { LINEAR_CLIENT_SECRET: "" }
          : scenario === "precedence"
          ? { LINEAR_API_KEY: "existing-key" }
          : scenario === "scope"
          ? { LINEAR_CLIENT_SCOPE: "read,write" }
          : scenario === "emptyScope"
          ? { LINEAR_CLIENT_SCOPE: "" }
          : {},
      ).output()
      noSecrets(result)
      assertEquals(
        result.code,
        ["precedence", "help", "scope", "revoked400", "revoked401"].includes(
            scenario,
          )
          ? 0
          : 1,
        decoder.decode(result.stderr),
      )
      assertEquals(
        requests.map((r) => r.path),
        scenario === "token"
          ? ["/oauth/token"]
          : ["type", "header"].includes(scenario)
          ? ["/oauth/token", "/oauth/revoke"]
          : ["revoke", "scope", "revoked400", "revoked401", "denied401"]
              .includes(scenario)
          ? ["/oauth/token", "/graphql", "/oauth/revoke"]
          : scenario === "precedence"
          ? ["/graphql"]
          : [],
      )
      if (scenario === "precedence") {
        assertEquals(requests[0]!.authorization, "existing-key")
      }
      if (scenario === "scope") {
        assertEquals(
          new URLSearchParams(requests[0]!.body).get("scope"),
          "read,write",
        )
      }
    })
  }
})

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  Deno.test({
    name:
      `client credentials revoke on ${signal} during token exchange, command, and cleanup`,
    ignore: Deno.build.os === "windows",
    fn: async () => {
      for (const pause of ["token", "graphql", "revoke"] as const) {
        await fixture(
          { pause },
          async ({ run, requests, reached, release }) => {
            const child = run(["auth", "whoami", "--json"])
            const output = child.output()
            await Promise.race([
              reached,
              output.then(() => {
                throw new Error(`Child exited before reaching ${pause}`)
              }),
            ])
            child.kill(signal)
            // Let the child receive the OS signal before unblocking its HTTP
            // response; otherwise a fast response can win the signal race.
            await new Promise((resolve) => setTimeout(resolve, 50))
            // A second signal must not interrupt the in-flight cleanup.
            if (pause !== "graphql") {
              child.kill(signal)
              await new Promise((resolve) => setTimeout(resolve, 50))
            }
            release()
            const result = await output
            noSecrets(result)
            assertEquals(result.code, signal === "SIGINT" ? 130 : 143)
            assertEquals(
              requests.filter((r) => r.path === "/oauth/revoke").length,
              1,
            )
            if (pause === "token") {
              assertEquals(requests.some((r) => r.path === "/graphql"), false)
            }
          },
        )
      }
    },
  })
}
