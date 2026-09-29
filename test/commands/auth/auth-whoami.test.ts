import { snapshotTest } from "@cliffy/testing"
import { assertEquals, assertStringIncludes } from "@std/assert"
import { commonDenoArgs } from "../../utils/test-helpers.ts"
import { whoamiCommand } from "../../../src/commands/auth/auth-whoami.ts"
import { MockLinearServer } from "../../utils/mock_linear_server.ts"

await snapshotTest({
  name: "Auth Whoami Command - JSON viewer",
  meta: import.meta,
  colors: false,
  args: ["--json"],
  denoArgs: ["--allow-all", "--quiet"],
  async fn() {
    const server = new MockLinearServer([{
      queryName: "AuthStatus",
      variables: {},
      response: {
        data: {
          viewer: {
            id: "user-1",
            name: "Pat",
            displayName: "Pat Example",
            email: "pat@example.com",
            admin: true,
            guest: false,
            app: false,
            organization: {
              id: "org-1",
              name: "Acme",
              urlKey: "acme",
              logoUrl: "https://example.com/logo.png",
            },
          },
        },
      },
    }])
    try {
      await server.start()
      Deno.env.set("LINEAR_GRAPHQL_ENDPOINT", server.getEndpoint())
      Deno.env.set("LINEAR_API_KEY", "Bearer test-token")
      await whoamiCommand.parse()
    } finally {
      await server.stop()
      Deno.env.delete("LINEAR_GRAPHQL_ENDPOINT")
      Deno.env.delete("LINEAR_API_KEY")
    }
  },
})

// An OAuth access token (for example an actor=app client credentials token)
// is supplied as the full header value; every request path forwards it as is.
Deno.test("OAuth Bearer token in LINEAR_API_KEY reaches typed and raw requests as an app actor", async () => {
  const viewer = {
    id: "app-user",
    name: "Claude",
    displayName: "claude",
    email: "claude@oauthapp.linear.app",
    admin: false,
    guest: false,
    app: true,
    organization: {
      id: "org-1",
      name: "Acme",
      urlKey: "acme",
      logoUrl: null,
    },
  }
  const server = new MockLinearServer([{
    queryName: "AuthStatus",
    response: { data: { viewer } },
  }, {
    queryName: "RawViewer",
    response: { data: { viewer: { id: "app-user" } } },
  }])
  try {
    await server.start()
    const run = (args: string[]) =>
      new Deno.Command(Deno.execPath(), {
        args: ["run", ...commonDenoArgs, "src/main.ts", ...args],
        env: {
          LINEAR_GRAPHQL_ENDPOINT: server.getEndpoint(),
          LINEAR_API_KEY: "Bearer oauth-access-token",
          NO_COLOR: "1",
        },
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      }).output()
    const json = await run(["auth", "whoami", "--json"])
    assertEquals(json.code, 0, new TextDecoder().decode(json.stderr))
    assertEquals(
      JSON.parse(new TextDecoder().decode(json.stdout)).app,
      true,
    )
    const human = await run(["auth", "whoami"])
    assertStringIncludes(
      new TextDecoder().decode(human.stdout),
      "Actor: app (OAuth application user)",
    )
    const raw = await run(["api", "query RawViewer { viewer { id } }"])
    assertEquals(raw.code, 0, new TextDecoder().decode(raw.stderr))
    assertEquals(server.graphqlAuthorizations, [
      "Bearer oauth-access-token",
      "Bearer oauth-access-token",
      "Bearer oauth-access-token",
    ])
  } finally {
    await server.stop()
  }
})
