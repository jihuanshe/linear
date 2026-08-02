import { snapshotTest } from "@cliffy/testing"
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
            organization: {
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
