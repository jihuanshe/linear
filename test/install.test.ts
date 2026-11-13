import { assert, assertEquals, assertMatch } from "@std/assert"
import { join } from "@std/path"

const installer = new URL("../install.sh", import.meta.url).pathname
const minimum = "0.0.1794558300-g5800a29"
const next = "0.0.1794558301-g1234567"
const archive = "linear-x86_64-unknown-linux-gnu.tar.xz"
const origin = "https://github.com/jihuanshe/linear/releases"
const pathLine =
  'export PATH="$HOME/.local/bin:$PATH" # jihuanshe/linear install.sh'
const decoder = new TextDecoder()

async function executable(path: string, source: string) {
  await Deno.writeTextFile(path, `#!/bin/bash\n${source}\n`, { mode: 0o755 })
}

async function fixture() {
  const root = await Deno.makeTempDir({ prefix: "linear-install-" })
  const home = join(root, "home")
  const mocks = join(root, "mocks")
  const assets = join(root, "assets")
  const repo = join(root, "repo")
  for (
    const directory of [home, mocks, assets, repo, join(home, ".local/bin")]
  ) {
    await Deno.mkdir(directory, { recursive: true })
  }
  const binary = join(home, ".local/bin/linear")
  await executable(binary, "echo old-linear")
  const profile = join(home, ".bash_profile")
  const oldBin = join(home, "old-shims")
  await Deno.mkdir(oldBin)
  await executable(join(oldBin, "linear"), "echo shadow-linear")
  await Deno.writeTextFile(
    join(home, ".env"),
    `export PATH="${oldBin}:${mocks}:/usr/bin:/bin"\n`,
  )
  await Deno.writeTextFile(
    profile,
    `${pathLine}\n. "$HOME/.env"\n`,
  )
  await executable(
    join(mocks, "curl"),
    `printf '%s\\n' "$*" >> "$TEST_ROOT/requests"
[[ "$1" == -q ]] || exit 90
output=''
while (($#)); do
  case "$1" in
    --output) output="$2"; shift ;;
    https://*) url="$1" ;;
  esac
  shift
done
echo 'curl diagnostic' >&2
case "$url" in
  */releases/latest/download/install.sh)
    [[ "\${FAILURE-}" != bootstrap ]] || exit 28
    cp "$TEST_INSTALLER" "$output"
    ;;
  */releases/latest)
    [[ "\${FAILURE-}" != latest ]] || exit 28
    printf '%s' "\${REDIRECT:-${origin}/tag/$TEST_TAG}"
    ;;
  */releases/download/"$TEST_TAG"/*)
    name="\${url##*/}"
    [[ "\${FAILURE-}" != timeout ]] || exit 28
    [[ "\${FAILURE-}" != checksum404 || "$name" != *.sha256 ]] || exit 22
    cp "$TEST_ASSETS/$name" "$output"
    ;;
  *) exit 91 ;;
esac`,
  )
  for (const command of ["gh", "git", "mise"]) {
    await executable(
      join(mocks, command),
      `echo ${command} >> "$TEST_ROOT/forbidden"; exit 99`,
    )
  }
  await executable(
    join(mocks, "uname"),
    'case "$1" in -s) echo "${TEST_OS:-Linux}";; -m) echo "${TEST_ARCH:-x86_64}";; esac',
  )
  const old = await Deno.readFile(binary)
  const env = {
    HOME: home,
    PATH: `${mocks}:/usr/bin:/bin`,
    TEST_ROOT: root,
    TEST_ASSETS: assets,
    TEST_TAG: minimum,
    TEST_INSTALLER: installer,
  }
  async function release(tag = minimum, version = tag, name = archive) {
    await executable(join(assets, "linear"), `echo 'linear ${version}'`)
    const tar = await new Deno.Command("tar", {
      args: ["-cJf", join(assets, name), "-C", assets, "linear"],
    }).output()
    assertEquals(tar.code, 0, decoder.decode(tar.stderr))
    const bytes = await Deno.readFile(join(assets, name))
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))
    const digest = Array.from(hash, (v) => v.toString(16).padStart(2, "0"))
      .join("")
    await Deno.writeTextFile(
      join(assets, `${name}.sha256`),
      `${digest}  ${name}\n`,
    )
  }
  async function run(
    extra: Record<string, string> = {},
    args: string[] = [],
    script = installer,
  ) {
    const result = await new Deno.Command("/bin/bash", {
      args: [script, ...args],
      cwd: repo,
      clearEnv: true,
      env: { ...env, ...extra },
    }).output()
    assertEquals(decoder.decode(result.stdout), "")
    assertEquals(await exists(join(root, "forbidden")), false)
    return { code: result.code, stderr: decoder.decode(result.stderr) }
  }
  await release()
  return {
    root,
    home,
    mocks,
    assets,
    repo,
    binary,
    profile,
    old,
    env,
    release,
    run,
    async cleanup() {
      await Deno.remove(root, { recursive: true })
    },
  }
}

async function exists(path: string) {
  try {
    await Deno.lstat(path)
    return true
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false
    throw error
  }
}

Deno.test("installer pins each latest, replaces atomically and repairs login PATH", async () => {
  const f = await fixture()
  try {
    assertEquals(await f.run(), { code: 0, stderr: "" })
    await f.release(next)
    // A later orb initialization resets PATH after the previously managed line.
    await Deno.writeTextFile(f.profile, '. "$HOME/.env"\n', {
      append: true,
    })
    assertEquals(await f.run({ TEST_TAG: next }), { code: 0, stderr: "" })
    const profile = await Deno.readTextFile(f.profile)
    assertEquals(profile.split(pathLine).length, 2)
    assert(profile.endsWith(`${pathLine}\n`))
    for (const cwd of [f.repo, f.home]) {
      const result = await new Deno.Command("/bin/bash", {
        args: ["-lc", "command -v linear; linear --version"],
        cwd,
        clearEnv: true,
        env: { HOME: f.home, PATH: "/usr/bin:/bin" },
      }).output()
      assertEquals(result.code, 0, decoder.decode(result.stderr))
      assertEquals(
        decoder.decode(result.stdout),
        `${f.binary}\nlinear ${next}\n`,
      )
    }
    const requests = (await Deno.readTextFile(join(f.root, "requests")))
      .trim().split("\n")
    assertEquals(requests.length, 6)
    for (const [index, tag] of [minimum, next].entries()) {
      for (const line of requests.slice(index * 3, index * 3 + 3)) {
        assertMatch(line, /^-q /)
        for (
          const option of [
            "--proto =https",
            "--proto-redir =https",
            "--connect-timeout 10",
            "--max-time 120",
            "--retry 2",
            "--retry-max-time 180",
          ]
        ) assert(line.includes(option), line)
        assert(!/Authorization|--user|--netrc|--config/.test(line))
      }
      assert(requests[index * 3].endsWith(`${origin}/latest`))
      assert(
        requests[index * 3 + 1].endsWith(
          `${origin}/download/${tag}/${archive}`,
        ),
      )
      assert(
        requests[index * 3 + 2].endsWith(
          `${origin}/download/${tag}/${archive}.sha256`,
        ),
      )
    }
  } finally {
    await f.cleanup()
  }
})

Deno.test("installer refuses failed stages, keeps the old file and emits one warning", async (t) => {
  const failures = {
    latest: "latest",
    redirect: "latest",
    unsupported: "platform",
    checksum404: "checksum-download",
    empty: "checksum",
    malformed: "checksum",
    "nul-checksum": "checksum",
    "blank-line": "checksum",
    "wrong-name": "checksum",
    "multiple-checksums": "checksum",
    mismatch: "checksum",
    timeout: "archive-download",
    unpack: "unpack",
    version: "version",
    "below-minimum": "minimum-version",
    "raised-minimum": "minimum-version",
    "lowered-minimum": "arguments",
    path: "path",
    publish: "publish",
    login: "login",
  }
  for (const [failure, stage] of Object.entries(failures)) {
    await t.step(failure, async () => {
      const f = await fixture()
      try {
        const env: Record<string, string> = { FAILURE: failure }
        const checksum = join(f.assets, `${archive}.sha256`)
        if (failure === "redirect") env.REDIRECT = "https://example.org/tag/x"
        if (failure === "unsupported") env.TEST_ARCH = "s390x"
        if (failure === "empty") await Deno.writeTextFile(checksum, "")
        if (failure === "malformed") {
          await Deno.writeTextFile(checksum, `abc  ${archive}\n`)
        }
        if (failure === "nul-checksum" || failure === "blank-line") {
          const text = await Deno.readTextFile(checksum)
          await Deno.writeTextFile(
            checksum,
            failure === "nul-checksum" ? `\0${text}` : `${text}\n`,
          )
        }
        if (failure === "wrong-name") {
          const text = await Deno.readTextFile(checksum)
          await Deno.writeTextFile(checksum, text.replace(archive, "other"))
        }
        if (failure === "multiple-checksums") {
          const text = await Deno.readTextFile(checksum)
          await Deno.writeTextFile(checksum, text + text)
        }
        if (failure === "mismatch") {
          await Deno.writeTextFile(checksum, `${"0".repeat(64)}  ${archive}\n`)
        }
        if (failure === "unpack") {
          // Valid checksum for a file that is not a tar archive.
          await Deno.writeTextFile(join(f.assets, archive), "broken")
          const hash = new Uint8Array(
            await crypto.subtle.digest(
              "SHA-256",
              new TextEncoder().encode("broken"),
            ),
          )
          const digest = Array.from(
            hash,
            (v) => v.toString(16).padStart(2, "0"),
          ).join("")
          await Deno.writeTextFile(checksum, `${digest}  ${archive}\n`)
        }
        if (failure === "version") await f.release(minimum, next)
        if (failure === "below-minimum") {
          env.TEST_TAG = "0.0.1794558299-gfffffff"
          await f.release(env.TEST_TAG)
        }
        if (failure === "raised-minimum") env.LINEAR_MIN_VERSION = next
        if (failure === "lowered-minimum") {
          env.LINEAR_MIN_VERSION = "0.0.1-g0000000"
        }
        if (failure === "publish") {
          await executable(
            join(f.mocks, "mv"),
            '[[ "${!#}" != "$HOME/.local/bin/linear" ]] || { echo failure >&2; exit 1; }; exec /bin/mv "$@"',
          )
        }
        if (failure === "path") {
          await executable(
            join(f.mocks, "mv"),
            '[[ "${!#}" != "$HOME/.bash_profile" ]] || { echo failure >&2; exit 1; }; exec /bin/mv "$@"',
          )
        }
        if (failure === "login") {
          await Deno.writeTextFile(f.profile, "linear() { echo shadow; }\n", {
            append: true,
          })
        }
        const profileBefore = await Deno.readTextFile(f.profile)
        for (const strict of [false, true]) {
          const result = await f.run(env, strict ? ["--strict"] : [])
          assertEquals(result.code, strict ? 1 : 0)
          assertEquals(
            result.stderr,
            `WARN: Linear CLI ${stage} failed; continuing setup\n`,
          )
          assertEquals(await Deno.readFile(f.binary), f.old)
          assertEquals(await Deno.readTextFile(f.profile), profileBefore)
          assertEquals(
            (await Array.fromAsync(Deno.readDir(join(f.home, ".local/bin"))))
              .map((entry) => entry.name),
            ["linear"],
          )
        }
      } finally {
        await f.cleanup()
      }
    })
  }
})

Deno.test("overlapping installers cannot overwrite a completed installation", async () => {
  const f = await fixture()
  let first: Deno.ChildProcess | undefined
  let result: Promise<Deno.CommandOutput> | undefined
  let released = false
  const gate = join(f.root, "gate")
  const entered = join(f.root, "entered")
  try {
    const fifo = await new Deno.Command("mkfifo", { args: [gate] }).output()
    assertEquals(fifo.code, 0)
    await executable(
      join(f.mocks, "mv"),
      `if [[ "\${PAUSE-}" == 1 && "$2" == */linear && "\${!#}" == "$HOME/.local/bin/linear" ]]; then
  /bin/mv "$@" || exit 1
  touch "$TEST_ROOT/entered"
  read -r release < "$TEST_ROOT/gate"
else
  exec /bin/mv "$@"
fi`,
    )
    first = new Deno.Command("/bin/bash", {
      args: [installer, "--strict"],
      cwd: f.repo,
      clearEnv: true,
      env: { ...f.env, PAUSE: "1" },
      stdout: "piped",
      stderr: "piped",
    }).spawn()
    result = first.output()
    for (let attempt = 0; attempt < 200 && !await exists(entered); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert(await exists(entered), "first installer did not reach publication")
    await f.release(next)
    const profileDuringFirst = await Deno.readTextFile(f.profile)
    assertEquals(await f.run({ TEST_TAG: next }), {
      code: 0,
      stderr: "WARN: Linear CLI lock failed; continuing setup\n",
    })
    assertEquals(await Deno.readTextFile(f.profile), profileDuringFirst)
    await Deno.writeTextFile(gate, "continue\n")
    released = true
    const completed = await result
    assertEquals(completed.code, 0, decoder.decode(completed.stderr))
    assertEquals(decoder.decode(completed.stdout), "")
    assertEquals(await f.run({ TEST_TAG: next }), { code: 0, stderr: "" })
    const version = await new Deno.Command(f.binary, { args: ["--version"] })
      .output()
    assertEquals(decoder.decode(version.stdout), `linear ${next}\n`)
  } finally {
    if (first != null && !released && await exists(entered)) {
      await Deno.writeTextFile(gate, "continue\n")
    }
    if (result != null) await result
    await f.cleanup()
  }
})

Deno.test("installer preserves profile symlinks and rolls back a previous symlink", async () => {
  const f = await fixture()
  try {
    const dotfile = join(f.home, "dotfile")
    await Deno.rename(f.profile, dotfile)
    await Deno.symlink("dotfile", f.profile)
    const previous = join(f.home, "previous-linear")
    await Deno.rename(f.binary, previous)
    await Deno.symlink(previous, f.binary)
    await Deno.writeTextFile(dotfile, "linear() { echo shadow; }\n", {
      append: true,
    })
    assertEquals(
      (await f.run()).stderr,
      "WARN: Linear CLI login failed; continuing setup\n",
    )
    assertEquals(await Deno.readLink(f.binary), previous)
    assertEquals(await Deno.readFile(previous), f.old)
    assertEquals(await Deno.readLink(f.profile), "dotfile")
    await Deno.writeTextFile(dotfile, '. "$HOME/.env"\n')
    assertEquals(await f.run(), { code: 0, stderr: "" })
    assertEquals(await Deno.readFile(previous), f.old)
    assertEquals(await Deno.readLink(f.profile), "dotfile")
  } finally {
    await f.cleanup()
  }
})

Deno.test("signals during either rename restore login and binary with one warning", async (t) => {
  for (const signal of ["HUP", "INT", "TERM"]) {
    for (const destination of ["profile", "binary"] as const) {
      await t.step(`${signal} ${destination}`, async () => {
        const f = await fixture()
        try {
          const before = await Deno.readTextFile(f.profile)
          await executable(
            join(f.mocks, "mv"),
            `/bin/mv "$@" || exit 1
if [[ "\${!#}" == "$INTERRUPT_DEST" && ( "$2" == */next || "$2" == */linear ) ]]; then
  kill -"$INTERRUPT_SIGNAL" "$PPID"
fi`,
          )
          for (const strict of [false, true]) {
            assertEquals(
              await f.run({
                INTERRUPT_DEST: destination === "profile"
                  ? f.profile
                  : f.binary,
                INTERRUPT_SIGNAL: signal,
              }, strict ? ["--strict"] : []),
              {
                code: strict ? 1 : 0,
                stderr: `WARN: Linear CLI ${
                  destination === "profile" ? "path" : "publish"
                } failed; continuing setup\n`,
              },
            )
            assertEquals(await Deno.readTextFile(f.profile), before)
            assertEquals(await Deno.readFile(f.binary), f.old)
            assertEquals(
              await exists(join(f.home, ".local/bin/.linear-install.lock")),
              false,
            )
          }
        } finally {
          await f.cleanup()
        }
      })
    }
  }
})

Deno.test("installer removes a failed first installation after login rejection", async () => {
  const f = await fixture()
  try {
    await Deno.remove(f.binary)
    await Deno.remove(f.profile)
    assertEquals(
      await f.run({ "BASH_FUNC_linear%%": "() { echo shadow; }" }, [
        "--strict",
      ]),
      {
        code: 1,
        stderr: "WARN: Linear CLI login failed; continuing setup\n",
      },
    )
    assertEquals(await exists(f.binary), false)
    assertEquals(await exists(f.profile), false)
  } finally {
    await f.cleanup()
  }
})

Deno.test("documented setup wrapper contains download and installer failures", async () => {
  const f = await fixture()
  try {
    const docs = await Deno.readTextFile(
      new URL("../docs/setup.md", import.meta.url),
    )
    const source = docs.split("### Orb setup")[1].match(
      /```bash\n([\s\S]*?)\n```/,
    )?.[1]
    assert(source)
    const wrapper = join(f.root, "wrapper.sh")
    await Deno.writeTextFile(
      wrapper,
      `set -euo pipefail\n${source}\necho continued >&2\n`,
    )
    for (const failure of ["bootstrap", "checksum404", ""]) {
      const result = await f.run({ FAILURE: failure }, [], wrapper)
      assertEquals(result.code, 0)
      assertEquals(
        result.stderr,
        failure
          ? "WARN: Linear CLI bootstrap failed; continuing setup\ncontinued\n"
          : "continued\n",
      )
    }
  } finally {
    await f.cleanup()
  }
})

Deno.test("installer supports platform aliases, login files and raised minimum argument", async (t) => {
  for (
    const [os, arch, target, login] of [
      ["Linux", "aarch64", "aarch64-unknown-linux-gnu", ".bash_login"],
      ["Linux", "arm64", "aarch64-unknown-linux-gnu", ".profile"],
      ["Darwin", "arm64", "aarch64-apple-darwin", ".bash_profile"],
    ]
  ) {
    await t.step(`${os} ${arch} ${login}`, async () => {
      const f = await fixture()
      try {
        await Deno.remove(f.profile)
        if (login !== ".bash_profile") {
          await Deno.writeTextFile(
            join(f.home, login),
            'export PATH="/bin:/usr/bin"\n',
          )
        }
        await f.release(next, next, `linear-${target}.tar.xz`)
        const env: Record<string, string> = {
          TEST_OS: os,
          TEST_ARCH: arch,
          TEST_TAG: next,
        }
        if (os === "Darwin") {
          // macOS provides shasum rather than GNU sha256sum.
          for (
            const command of [
              "cp",
              "cat",
              "mktemp",
              "shasum",
              "tr",
              "tar",
              "xz",
              "chmod",
              "awk",
              "mkdir",
              "ln",
              "mv",
              "rm",
              "rmdir",
            ]
          ) {
            await Deno.symlink(`/usr/bin/${command}`, join(f.mocks, command))
          }
          env.PATH = f.mocks
        }
        assertEquals(
          await f.run(
            env,
            ["--strict", "--min-version", next],
          ),
          { code: 0, stderr: "" },
        )
        assert(
          (await Deno.readTextFile(join(f.home, login))).endsWith(
            `${pathLine}\n`,
          ),
        )
      } finally {
        await f.cleanup()
      }
    })
  }
})
