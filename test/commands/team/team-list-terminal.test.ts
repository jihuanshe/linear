import { assertEquals, assertStringIncludes } from "@std/assert"
import { stripAnsiCode } from "@std/fmt/colors"
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

for (const mode of ["pipe", "TTY", "NO_COLOR TTY"] as const) {
  Deno.test({
    name:
      `team list through main preserves literal directives and Unicode columns: ${mode}`,
    // util-linux script supplies a real PTY; the pipe case is platform-neutral.
    ignore: mode !== "pipe" && Deno.build.os !== "linux",
    async fn() {
      const directory = await Deno.makeTempDir()
      const updatedAt = new Date().toISOString()
      const server = new MockLinearServer([{
        queryName: "GetTeams",
        response: {
          data: {
            teams: {
              nodes: [
                {
                  id: "team-2",
                  key: "%d",
                  name: "B🙂",
                  color: "#ab2345",
                  cyclesEnabled: false,
                  updatedAt,
                  archivedAt: null,
                },
                {
                  id: "team-1",
                  key: "%c",
                  name: "A 界 %c %s %d",
                  color: "#123456",
                  cyclesEnabled: true,
                  updatedAt,
                  archivedAt: null,
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      }])
      server.start()
      try {
        const args = [
          "run",
          "--allow-all",
          "--quiet",
          "--config",
          config,
          main,
          "team",
          "list",
        ]
        const command = mode === "pipe" ? Deno.execPath() : "script"
        const shellCommand = [Deno.execPath(), ...args]
          .map((arg) => `'${arg.replaceAll("'", "'\\''")}'`).join(" ")
        const result = await new Deno.Command(command, {
          args: mode === "pipe" ? args : [
            "-qec",
            `stty cols 120; exec ${shellCommand}`,
            "/dev/null",
          ],
          cwd: directory,
          stdin: "null",
          stdout: "piped",
          stderr: "piped",
          clearEnv: true,
          env: {
            HOME: directory,
            XDG_CONFIG_HOME: directory,
            APPDATA: directory,
            DENO_DIR: denoDir,
            PATH: Deno.env.get("PATH") ?? "",
            TERM: "xterm-256color",
            LINEAR_API_KEY: "test-token",
            LINEAR_GRAPHQL_ENDPOINT: server.getEndpoint(),
            ...(mode === "NO_COLOR TTY" ? { NO_COLOR: "" } : {}),
          },
        }).output()
        const stdout = new TextDecoder().decode(result.stdout)
        const stderr = new TextDecoder().decode(result.stderr)
        assertEquals(result.code, 0, stdout + stderr)
        assertEquals(stderr, "")
        assertEquals(server.graphqlRequests.length, 1)
        const plain = stripAnsiCode(stdout).replaceAll("\r", "")
        assertEquals(
          plain.slice(plain.indexOf("KEY")),
          [
            "KEY NAME          CYCLES UPDATED  ID    ",
            "%c  A 界 %c %s %d Yes    just now team-1",
            "%d  B🙂           No     just now team-2",
            "",
          ].join("\n"),
        )
        if (mode === "TTY") {
          // CSS formerly carried styling through plain parts until the next
          // styled part: the whole header, then key/name/cycles, then date/ID.
          assertStringIncludes(
            stdout,
            "\x1b[4mKEY NAME          CYCLES UPDATED  ID    \x1b[24m",
          )
          assertStringIncludes(
            stdout,
            "\x1b[38;2;18;52;86m%c  A 界 %c %s %d Yes    \x1b[39m",
          )
          assertStringIncludes(
            stdout,
            "\x1b[38;2;171;35;69m%d  B🙂           No     \x1b[39m",
          )
          assertStringIncludes(
            stdout,
            "\x1b[38;2;128;128;128mjust now team-1\x1b[39m",
          )
        } else {
          assertEquals(stdout.includes("\x1b"), false)
        }
      } finally {
        await server.stop()
        await Deno.remove(directory, { recursive: true })
      }
    },
  })
}
