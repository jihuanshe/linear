import {
  assertEquals,
  assertMatch,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert"
import { encodeHex } from "@std/encoding/hex"
import { fromFileUrl, join } from "@std/path"
import { cli } from "../../src/cli.ts"
import {
  getSelfUpdateAssetName,
  isMiseManagedInstallation,
  updateCommand,
  updateStandaloneInstallation,
  updateWithMise,
} from "../../src/commands/update.ts"
import { CliError } from "../../src/utils/errors.ts"

async function writeExecutable(path: string, content: string): Promise<void> {
  await Deno.writeTextFile(path, content)
  if (Deno.build.os !== "windows") await Deno.chmod(path, 0o755)
}

async function sha256(data: Uint8Array<ArrayBuffer>): Promise<string> {
  return encodeHex(
    new Uint8Array(await crypto.subtle.digest("SHA-256", data)),
  )
}

Deno.test("cli - update command is registered", () => {
  assertEquals(cli.getCommand("update"), updateCommand)
})

Deno.test("update - selects release asset for each supported target", () => {
  assertEquals(
    getSelfUpdateAssetName("aarch64-apple-darwin"),
    "linear-self-update-aarch64-apple-darwin",
  )
  assertEquals(
    getSelfUpdateAssetName("x86_64-pc-windows-msvc"),
    "linear-self-update-x86_64-pc-windows-msvc.exe",
  )
  assertThrows(
    () => getSelfUpdateAssetName("riscv64-unknown-linux-gnu"),
    CliError,
    "Unsupported self-update target",
  )
})

Deno.test("update - detects the selected mise executable by identity", async () => {
  const root = await Deno.makeTempDir()
  try {
    const executable = join(root, "linear")
    const mise = join(root, "mise")
    await writeExecutable(executable, "old binary")
    await writeExecutable(
      mise,
      `#!/bin/sh\nprintf '%s\\n' '${executable}'\n`,
    )

    assertEquals(
      await isMiseManagedInstallation({
        executablePath: executable,
        miseExecutable: mise,
        miseInstallRoots: [],
      }),
      true,
    )
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test("update - does not confuse an activated mise with ownership", async () => {
  const root = await Deno.makeTempDir()
  try {
    const executable = join(root, "standalone-linear")
    const selected = join(root, "mise-linear")
    const mise = join(root, "mise")
    await writeExecutable(executable, "standalone")
    await writeExecutable(selected, "managed")
    await writeExecutable(
      mise,
      `#!/bin/sh\nprintf '%s\\n' '${selected}'\n`,
    )

    assertEquals(
      await isMiseManagedInstallation({
        executablePath: executable,
        miseExecutable: mise,
        miseInstallRoots: [],
      }),
      false,
    )
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test("update - never treats a likely mise install as standalone", async () => {
  const root = await Deno.makeTempDir()
  try {
    const installs = join(root, "mise", "installs")
    const executable = join(installs, "linear", "1", "bin", "linear")
    await Deno.mkdir(join(installs, "linear", "1", "bin"), {
      recursive: true,
    })
    await writeExecutable(executable, "managed")

    const error = await assertRejects(
      () =>
        isMiseManagedInstallation({
          executablePath: executable,
          miseExecutable: join(root, "missing-mise"),
          miseInstallRoots: [installs],
        }),
      CliError,
      "mise is unavailable",
    )
    assertStringIncludes(error.suggestion ?? "", "mise up")
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test("update - passes explicit bump intent to mise", async () => {
  if (Deno.build.os === "windows") return
  const root = await Deno.makeTempDir()
  try {
    const mise = join(root, "mise")
    const argsFile = join(root, "args")
    await writeExecutable(
      mise,
      `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsFile}'\n`,
    )

    await updateWithMise(mise, true)
    assertEquals(
      await Deno.readTextFile(argsFile),
      "up\n--bump\ngithub:jihuanshe/linear\n",
    )
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

interface ReleaseServerOptions {
  version: string
  assetName: string
  binary: Uint8Array<ArrayBuffer>
  checksum?: string
}

function startReleaseServer(options: ReleaseServerOptions) {
  let origin = ""
  const server = Deno.serve(
    {
      hostname: "127.0.0.1",
      port: 0,
      onListen({ hostname, port }) {
        origin = `http://${hostname}:${port}`
      },
    },
    (request) => {
      const url = new URL(request.url)
      if (url.pathname === "/releases/latest") {
        return Response.redirect(
          `${origin}/releases/tag/${options.version}`,
          302,
        )
      }
      if (url.pathname === `/releases/tag/${options.version}`) {
        return new Response(null, { status: 200 })
      }
      if (
        url.pathname ===
          `/releases/download/${options.version}/${options.assetName}.sha256`
      ) {
        return new Response(
          `${options.checksum ?? "0".repeat(64)}  ${options.assetName}\n`,
        )
      }
      if (
        url.pathname ===
          `/releases/download/${options.version}/${options.assetName}`
      ) {
        return new Response(options.binary)
      }
      return new Response("not found", { status: 404 })
    },
  )
  return { server, releasesUrl: `${origin}/releases` }
}

Deno.test("update - replaces a standalone binary after checksum validation", async () => {
  const root = await Deno.makeTempDir()
  const assetName = "linear-self-update-x86_64-unknown-linux-gnu"
  const binary = new TextEncoder().encode("new binary")
  const release = startReleaseServer({
    version: "0.0.2-gabcdef0",
    assetName,
    binary,
    checksum: await sha256(binary),
  })
  try {
    const executable = join(root, "linear")
    await writeExecutable(executable, "old binary")

    const result = await updateStandaloneInstallation({
      executablePath: executable,
      currentVersion: "0.0.1-g1234567",
      target: "x86_64-unknown-linux-gnu",
      os: "linux",
      releasesUrl: release.releasesUrl,
    })

    assertEquals(result, { updated: true, version: "0.0.2-gabcdef0" })
    assertEquals(await Deno.readTextFile(executable), "new binary")
  } finally {
    await release.server.shutdown()
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test("update - checksum mismatch preserves a standalone binary", async () => {
  const root = await Deno.makeTempDir()
  const assetName = "linear-self-update-x86_64-unknown-linux-gnu"
  const binary = new TextEncoder().encode("new binary")
  const release = startReleaseServer({
    version: "0.0.2-gabcdef0",
    assetName,
    binary,
  })
  try {
    const executable = join(root, "linear")
    await writeExecutable(executable, "old binary")

    const error = await assertRejects(
      () =>
        updateStandaloneInstallation({
          executablePath: executable,
          currentVersion: "0.0.1-g1234567",
          target: "x86_64-unknown-linux-gnu",
          os: "linux",
          releasesUrl: release.releasesUrl,
        }),
      CliError,
      "Checksum mismatch",
    )
    assertStringIncludes(error.suggestion ?? "", "was not changed")
    assertEquals(await Deno.readTextFile(executable), "old binary")
  } finally {
    await release.server.shutdown()
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test("update - development entry point refuses self-update", async () => {
  const main = fromFileUrl(new URL("../../src/main.ts", import.meta.url))
  const result = await new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-all", "--quiet", main, "update"],
    stdout: "piped",
    stderr: "piped",
    clearEnv: true,
    env: {
      HOME: Deno.env.get("HOME") ?? "",
      PATH: Deno.env.get("PATH") ?? "",
      NO_COLOR: "1",
    },
  }).output()

  assertEquals(result.code, 1)
  assertEquals(new TextDecoder().decode(result.stdout), "")
  assertMatch(
    new TextDecoder().decode(result.stderr),
    /Development builds cannot update themselves/,
  )
})
