import { assertEquals, assertStringIncludes } from "@std/assert"
import { fromFileUrl } from "@std/path"
import { cli } from "../../src/cli.ts"
import {
  versionCommand,
  type VersionDocument,
} from "../../src/commands/version.ts"

const main = fromFileUrl(new URL("../../src/main.ts", import.meta.url))

async function run(args: string[]) {
  const result = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--quiet",
      "--config=deno.json",
      "--frozen",
      "--lock=deno.lock",
      "--cached-only",
      "--allow-env",
      "--deny-net",
      "--allow-read=/nonexistent",
      "--deny-write",
      "--deny-run",
      "--deny-ffi",
      main,
      ...args,
    ],
    stdout: "piped",
    stderr: "piped",
    clearEnv: true,
    env: {
      HOME: Deno.env.get("HOME") ?? "/nonexistent",
      XDG_CONFIG_HOME: "/nonexistent",
      NO_COLOR: "1",
    },
  }).output()
  const decoder = new TextDecoder()
  return {
    code: result.code,
    stdout: decoder.decode(result.stdout),
    stderr: decoder.decode(result.stderr),
  }
}

Deno.test("cli - version command is registered", () => {
  assertEquals(cli.getCommand("version"), versionCommand)
})

Deno.test("version reports deterministic build identity offline without authentication", async () => {
  const result = await run(["version"])

  assertEquals(result.code, 0, result.stderr)
  assertEquals(result.stderr, "")
  assertEquals(
    result.stdout,
    "distribution: jihuanshe/linear\n" +
      "version: 0.0.0-dev\n" +
      "capabilities: usage-v1, guide-v1, delivery-v1\n",
  )
})

Deno.test("version --json reports the stable build identity contract offline", async () => {
  const result = await run(["version", "--json"])

  assertEquals(result.code, 0, result.stderr)
  assertEquals(result.stderr, "")
  assertEquals(JSON.parse(result.stdout), {
    schemaVersion: 1,
    distribution: "jihuanshe/linear",
    version: "0.0.0-dev",
    capabilities: ["usage-v1", "guide-v1", "delivery-v1"],
  })
})

Deno.test("version JSON v1 readers can ignore additive fields", () => {
  const readV1 = (value: unknown) => {
    const document = value as VersionDocument
    return {
      schemaVersion: document.schemaVersion,
      distribution: document.distribution,
      version: document.version,
      supportsUsageV1: document.capabilities.includes("usage-v1"),
    }
  }
  const document: VersionDocument = {
    schemaVersion: 1,
    distribution: "jihuanshe/linear",
    version: "0.0.0-dev",
    capabilities: ["usage-v1"],
  }

  assertEquals(
    readV1({
      ...document,
      futureField: true,
      capabilities: [...document.capabilities, "future-v1"],
    }),
    {
      schemaVersion: 1,
      distribution: "jihuanshe/linear",
      version: "0.0.0-dev",
      supportsUsageV1: true,
    },
  )
})

Deno.test("version keeps the existing root --version output", async () => {
  const result = await run(["--version"])

  assertEquals(result.code, 0, result.stderr)
  assertEquals(result.stderr, "")
  assertEquals(result.stdout, "linear 0.0.0-dev\n")
})

Deno.test("version help describes its machine-readable output", async () => {
  const result = await run(["version", "--help"])

  assertEquals(result.code, 0, result.stderr)
  assertEquals(result.stderr, "")
  assertStringIncludes(
    result.stdout,
    "Show build identity and protocol capabilities",
  )
  assertStringIncludes(result.stdout, "--json")
  assertStringIncludes(result.stdout, "Output machine-readable build identity")
})
