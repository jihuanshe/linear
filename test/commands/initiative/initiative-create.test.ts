import { assertEquals, assertStringIncludes } from "@std/assert"
import { MockLinearServer } from "../../utils/mock_linear_server.ts"

for (const [stdin, stdout] of [[false, false], [false, true], [true, false]]) {
  for (const interactive of [false, true]) {
    Deno.test(`initiative create requires both terminals for interaction: stdin=${stdin}, stdout=${stdout}, explicit=${interactive}`, async () => {
      const server = new MockLinearServer()
      await server.start()
      try {
        const args = interactive ? ["--name", "Example", "--interactive"] : []
        const code = `
          import { cli } from "./src/cli.ts";
          import { Input, Select } from "./src/utils/prompt.ts";
          Deno.stdin.isTerminal = () => ${stdin};
          Deno.stdout.isTerminal = () => ${stdout};
          Input.prompt = Select.prompt = () => { throw new Error("unexpected prompt"); };
          await cli.parse(["initiative", "create", ...${JSON.stringify(args)}]);
        `
        const result = await new Deno.Command(Deno.execPath(), {
          args: ["eval", "--quiet", code],
          stdin: "null",
          stdout: "piped",
          stderr: "piped",
          env: {
            LINEAR_API_KEY: "test-token",
            LINEAR_GRAPHQL_ENDPOINT: server.getEndpoint(),
            NO_COLOR: "1",
          },
        }).output()
        assertEquals(result.code, 1)
        assertStringIncludes(
          new TextDecoder().decode(result.stderr),
          interactive
            ? "Interactive creation requires a terminal"
            : "Initiative name is required",
        )
        assertEquals(server.graphqlRequests, [])
      } finally {
        await server.stop()
      }
    })
  }
}
