import { assertEquals, assertStringIncludes } from "@std/assert"
import { fromFileUrl } from "@std/path"
import { MockLinearServer } from "../../utils/mock_linear_server.ts"

const main = fromFileUrl(new URL("../../../src/main.ts", import.meta.url))
const config = fromFileUrl(new URL("../../../deno.json", import.meta.url))
const { denoDir } = JSON.parse(new TextDecoder().decode(
  (await new Deno.Command(Deno.execPath(), {
    args: ["info", "--json"],
    stdout: "piped",
  }).output()).stdout,
)) as { denoDir: string }

Deno.test({
  name:
    "interactive issue creation preserves pasted Chinese and emoji through a real PTY",
  // util-linux script supplies a real PTY, independent of tmux or stdin mocks.
  ignore: Deno.build.os !== "linux",
  async fn() {
    const directory = await Deno.makeTempDir()
    const teamId = "11111111-1111-4111-8111-111111111111"
    const title = "Release-17 发布总控🙂与回滚演练"
    const server = new MockLinearServer([
      {
        queryName: "GetWriteTeamByKey",
        response: {
          data: {
            teams: {
              nodes: [{ id: teamId, key: "ENG", name: "Engineering" }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
      {
        queryName: "GetWorkflowStates",
        response: { data: { team: { states: { nodes: [] } } } },
      },
      {
        queryName: "GetLabelsForTeam",
        response: { data: { team: { labels: { nodes: [] } } } },
      },
      {
        queryName: "CreateIssue",
        response: {
          data: {
            issueCreate: {
              success: true,
              issue: {
                id: "22222222-2222-4222-8222-222222222222",
                identifier: "ENG-123",
                title,
                url: "https://linear.app/test/issue/ENG-123",
                team: { key: "ENG" },
              },
            },
          },
        },
      },
    ])
    server.start()
    try {
      const binary = Deno.env.get("LINEAR_PROMPT_TEST_BIN")
      const command = [
        ...(binary ? [binary] : [
          Deno.execPath(),
          "run",
          "--allow-all",
          "--quiet",
          "--config",
          config,
          main,
        ]),
        "issue",
        "create",
      ]
        .map((arg) => `'${arg.replaceAll("'", "'\\''")}'`).join(" ")
      const child = new Deno.Command("script", {
        args: ["-qefc", `stty cols 120; exec ${command}`, "/dev/null"],
        cwd: directory,
        stdin: "piped",
        stdout: "piped",
        stderr: "piped",
        signal: AbortSignal.timeout(15_000),
        clearEnv: true,
        env: {
          HOME: directory,
          XDG_CONFIG_HOME: directory,
          DENO_DIR: denoDir,
          PATH: Deno.env.get("PATH") ?? "",
          TERM: "xterm-256color",
          LANG: "C.UTF-8",
          NO_COLOR: "1",
          LINEAR_API_KEY: "test-token",
          LINEAR_GRAPHQL_ENDPOINT: server.getEndpoint(),
          LINEAR_TEAM_KEY: "ENG",
          LINEAR_ISSUE_CREATE_ASSIGN_SELF: "never",
          LINEAR_ISSUE_CREATE_ASK_PROJECT: "false",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
        },
      }).spawn()
      const writer = child.stdin.getWriter()
      const prompts = [
        "What's the title of your issue?",
        "Description",
        "What's next?",
      ]
      const replies = [title + "\r", "\r", "\r"]
      let output = ""
      let stage = 0
      const consume = async () => {
        const decoder = new TextDecoder()
        for await (const bytes of child.stdout) {
          output += decoder.decode(bytes, { stream: true })
          if (stage < prompts.length && output.includes(prompts[stage])) {
            await writer.write(new TextEncoder().encode(replies[stage++]))
          }
        }
        output += decoder.decode()
      }
      const [status, stderr] = await Promise.all([
        child.status,
        new Response(child.stderr).text(),
        consume(),
      ])
      writer.releaseLock()
      await child.stdin.close()
      assertEquals(status.code, 0, output + stderr)
      assertEquals(stage, 3, output)
      const writes = server.graphqlRequests.filter((request) =>
        request.query.includes("mutation ")
      )
      assertEquals(writes.length, 1, output)
      const input = writes[0].variables.input as Record<string, unknown>
      assertEquals(input.title, title)
      assertEquals(Object.hasOwn(input, "description"), false)
      assertStringIncludes(output, `✓ Created issue ENG-123: ${title}`)
    } finally {
      await server.stop()
      await Deno.remove(directory, { recursive: true })
    }
  },
})
