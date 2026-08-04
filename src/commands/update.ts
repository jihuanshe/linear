import { Command } from "@cliffy/command"
import { encodeHex } from "@std/encoding/hex"
import { isAbsolute, join, relative, resolve } from "@std/path"
import denoConfig from "../../deno.json" with { type: "json" }
import { CliError, handleError } from "../utils/errors.ts"
import { success, warning } from "../utils/styling.ts"

const MISE_TOOL = "github:jihuanshe/linear"
const RELEASES_URL = "https://github.com/jihuanshe/linear/releases"
const DEVELOPMENT_VERSION = "0.0.0-dev"
const SUPPORTED_TARGETS = new Set([
  "aarch64-apple-darwin",
  "x86_64-apple-darwin",
  "aarch64-unknown-linux-gnu",
  "x86_64-unknown-linux-gnu",
  "x86_64-pc-windows-msvc",
])

export interface MiseDetectionOptions {
  executablePath: string
  miseExecutable?: string
  miseInstallRoots?: string[]
}

export interface StandaloneUpdateOptions {
  executablePath: string
  currentVersion: string
  target: string
  os: typeof Deno.build.os
  releasesUrl?: string
}

export interface StandaloneUpdateResult {
  updated: boolean
  version: string
  staleBackupPath?: string
}

function isWithinPath(parent: string, child: string): boolean {
  const path = relative(resolve(parent), child)
  const firstSegment = path.split(/[\\/]/, 1)[0]
  return path === "" || (!isAbsolute(path) && firstSegment !== "..")
}

function getKnownMiseInstallRoots(): string[] {
  const roots = new Set<string>()
  const installsDir = Deno.env.get("MISE_INSTALLS_DIR")
  const dataDir = Deno.env.get("MISE_DATA_DIR")
  const xdgDataHome = Deno.env.get("XDG_DATA_HOME")
  const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE")
  const localAppData = Deno.env.get("LOCALAPPDATA")

  if (installsDir) roots.add(installsDir)
  if (dataDir) roots.add(join(dataDir, "installs"))
  if (xdgDataHome) roots.add(join(xdgDataHome, "mise", "installs"))
  if (home) roots.add(join(home, ".local", "share", "mise", "installs"))
  if (localAppData) roots.add(join(localAppData, "mise", "installs"))

  return [...roots]
}

function looksLikeMiseInstall(
  executablePath: string,
  installRoots: string[],
): boolean {
  if (installRoots.some((root) => isWithinPath(root, executablePath))) {
    return true
  }

  const normalized = executablePath.replaceAll("\\", "/")
  return normalized.includes("/mise/installs/")
}

/**
 * Determine ownership by executable identity, not by ambient MISE_* variables.
 * A shell can be activated by mise while running an unrelated standalone binary.
 */
export async function isMiseManagedInstallation(
  options: MiseDetectionOptions,
): Promise<boolean> {
  const miseExecutable = options.miseExecutable ?? "mise"
  let executablePath: string
  try {
    executablePath = await Deno.realPath(options.executablePath)
  } catch (error) {
    throw new CliError("Could not resolve the current executable path", {
      suggestion: "Reinstall Linear CLI, then try again.",
      cause: error,
    })
  }

  const likelyMiseInstall = looksLikeMiseInstall(
    executablePath,
    options.miseInstallRoots ?? getKnownMiseInstallRoots(),
  )

  let result: Deno.CommandOutput
  try {
    result = await new Deno.Command(miseExecutable, {
      args: ["which", "linear"],
      stdout: "piped",
      stderr: "piped",
    }).output()
  } catch (error) {
    if (error instanceof Deno.errors.NotFound && !likelyMiseInstall) {
      return false
    }
    throw new CliError(
      likelyMiseInstall
        ? "This Linear CLI appears to be managed by mise, but mise is unavailable"
        : "Could not check whether mise manages this Linear CLI",
      {
        suggestion: likelyMiseInstall
          ? `Install mise and run \`mise up ${MISE_TOOL}\`.`
          : "Check your mise installation or remove it from PATH, then try again.",
        cause: error,
      },
    )
  }

  if (!result.success) {
    if (!likelyMiseInstall) return false
    throw new CliError(
      "This Linear CLI appears to be installed by mise, but it is not the active mise version",
      {
        suggestion: `Run \`mise up ${MISE_TOOL}\` directly.`,
      },
    )
  }

  const selectedPath = new TextDecoder().decode(result.stdout).trim()
  if (!selectedPath) {
    throw new CliError("mise returned an empty path for Linear CLI", {
      suggestion: "Run `mise doctor`, then try again.",
    })
  }

  let resolvedSelectedPath: string
  try {
    resolvedSelectedPath = await Deno.realPath(selectedPath)
  } catch (error) {
    throw new CliError("mise returned an invalid path for Linear CLI", {
      suggestion: `Run \`mise install ${MISE_TOOL}\`, then try again.`,
      cause: error,
    })
  }

  if (resolvedSelectedPath === executablePath) return true
  if (!likelyMiseInstall) return false

  throw new CliError(
    "This Linear CLI belongs to mise, but a different mise version is active",
    {
      suggestion: `Run \`mise up ${MISE_TOOL}\` directly.`,
    },
  )
}

export async function updateWithMise(
  miseExecutable = "mise",
  bump = false,
): Promise<void> {
  const args = ["up"]
  if (bump) args.push("--bump")
  args.push(MISE_TOOL)

  let process: Deno.ChildProcess
  try {
    process = new Deno.Command(miseExecutable, {
      args,
      env: { MISE_FETCH_REMOTE_VERSIONS_CACHE: "0s" },
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    }).spawn()
  } catch (error) {
    throw new CliError("Could not start mise", {
      suggestion: `Run \`mise up ${
        bump ? "--bump " : ""
      }${MISE_TOOL}\` directly.`,
      cause: error,
    })
  }

  const status = await process.status
  if (!status.success) {
    throw new CliError(`mise exited with status ${status.code}`, {
      suggestion: `Run \`mise up ${
        bump ? "--bump " : ""
      }${MISE_TOOL}\` directly for more details.`,
    })
  }
}

export function getSelfUpdateAssetName(target: string): string {
  if (!SUPPORTED_TARGETS.has(target)) {
    throw new CliError(`Unsupported self-update target: ${target}`, {
      suggestion: "Download the appropriate binary from GitHub Releases.",
    })
  }
  const extension = target === "x86_64-pc-windows-msvc" ? ".exe" : ""
  return `linear-self-update-${target}${extension}`
}

async function fetchRelease(
  url: string,
  description: string,
  init?: RequestInit,
): Promise<Response> {
  let response: Response
  try {
    response = await fetch(url, {
      ...init,
      headers: {
        Accept: "application/octet-stream",
        "User-Agent": `linear/${denoConfig.version}`,
        ...init?.headers,
      },
    })
  } catch (error) {
    throw new CliError(`Could not download ${description}`, {
      suggestion: "Check your network connection, then try again.",
      cause: error,
    })
  }

  if (!response.ok) {
    throw new CliError(
      `Could not download ${description}: HTTP ${response.status}`,
      {
        suggestion: "Try again later or download the release manually.",
      },
    )
  }
  return response
}

async function getLatestReleaseTag(releasesUrl: string): Promise<string> {
  const baseUrl = new URL(
    releasesUrl.endsWith("/") ? releasesUrl : `${releasesUrl}/`,
  )
  const latestUrl = new URL("latest", baseUrl)
  const response = await fetchRelease(
    latestUrl.href,
    "latest release metadata",
    {
      method: "HEAD",
    },
  )
  const resolvedUrl = new URL(response.url)
  const tagPrefix = `${baseUrl.pathname}tag/`

  if (
    resolvedUrl.origin !== baseUrl.origin ||
    !resolvedUrl.pathname.startsWith(tagPrefix)
  ) {
    throw new CliError("GitHub returned an unexpected latest release URL", {
      suggestion: "Try again later or download the release manually.",
    })
  }

  const tag = decodeURIComponent(resolvedUrl.pathname.slice(tagPrefix.length))
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(tag)) {
    throw new CliError(`GitHub returned an invalid release tag: ${tag}`, {
      suggestion: "Download the release manually.",
    })
  }
  return tag
}

function parseChecksum(checksumFile: string, assetName: string): string {
  for (const line of checksumFile.trim().split("\n")) {
    const match = /^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(line)
    if (match?.[2] === assetName) return match[1].toLowerCase()
  }
  throw new CliError(`Invalid checksum file for ${assetName}`, {
    suggestion: "Try again later or download the release manually.",
  })
}

async function getSha256(data: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data)
  return encodeHex(new Uint8Array(digest))
}

async function removeIfExists(path: string): Promise<void> {
  try {
    await Deno.remove(path)
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error
  }
}

async function replaceExecutable(
  executablePath: string,
  replacementPath: string,
  os: typeof Deno.build.os,
): Promise<string | undefined> {
  if (os !== "windows") {
    await Deno.rename(replacementPath, executablePath)
    return
  }

  // Windows cannot replace a running executable directly. Moving it aside
  // first allows the new binary to take its path; the next update cleans up
  // the backup if Windows keeps it locked until this process exits.
  const backupPath = `${executablePath}.old`
  await removeIfExists(backupPath)
  await Deno.rename(executablePath, backupPath)
  try {
    await Deno.rename(replacementPath, executablePath)
  } catch (error) {
    try {
      await Deno.rename(backupPath, executablePath)
    } catch (rollbackError) {
      throw new CliError(
        "Failed to install the update and restore the previous binary",
        {
          suggestion: `Restore ${backupPath} to ${executablePath} manually.`,
          cause: rollbackError,
        },
      )
    }
    throw error
  }

  try {
    await removeIfExists(backupPath)
    return
  } catch {
    return backupPath
  }
}

export async function updateStandaloneInstallation(
  options: StandaloneUpdateOptions,
): Promise<StandaloneUpdateResult> {
  const releasesUrl = options.releasesUrl ?? RELEASES_URL
  const version = await getLatestReleaseTag(releasesUrl)
  if (version === options.currentVersion) {
    return { updated: false, version }
  }

  const assetName = getSelfUpdateAssetName(options.target)
  const releaseUrl = new URL(
    `download/${encodeURIComponent(version)}/`,
    releasesUrl.endsWith("/") ? releasesUrl : `${releasesUrl}/`,
  )
  const checksumResponse = await fetchRelease(
    new URL(`${assetName}.sha256`, releaseUrl).href,
    `${assetName}.sha256`,
  )
  const expectedChecksum = parseChecksum(
    await checksumResponse.text(),
    assetName,
  )
  const binaryResponse = await fetchRelease(
    new URL(assetName, releaseUrl).href,
    assetName,
  )
  const binary = await binaryResponse.bytes()
  const actualChecksum = await getSha256(binary)
  if (actualChecksum !== expectedChecksum) {
    throw new CliError(`Checksum mismatch for ${assetName}`, {
      suggestion: "The installed binary was not changed. Try again later.",
    })
  }

  let executablePath: string
  let currentMode: number | null
  try {
    executablePath = await Deno.realPath(options.executablePath)
    currentMode = (await Deno.stat(executablePath)).mode
  } catch (error) {
    throw new CliError("Could not inspect the current Linear CLI binary", {
      suggestion: "Reinstall Linear CLI manually.",
      cause: error,
    })
  }

  const directory = resolve(executablePath, "..")
  const filename = executablePath.split(/[\\/]/).at(-1) ?? "linear"
  let replacementPath: string
  try {
    replacementPath = await Deno.makeTempFile({
      dir: directory,
      prefix: `.${filename}.update-`,
    })
  } catch (error) {
    throw new CliError("The Linear CLI install directory is not writable", {
      suggestion:
        "Reinstall with mise or rerun with permission to update the binary.",
      cause: error,
    })
  }

  try {
    await Deno.writeFile(replacementPath, binary)
    if (options.os !== "windows") {
      await Deno.chmod(
        replacementPath,
        currentMode == null ? 0o755 : currentMode & 0o777,
      )
    }
    const staleBackupPath = await replaceExecutable(
      executablePath,
      replacementPath,
      options.os,
    )
    return staleBackupPath
      ? { updated: true, version, staleBackupPath }
      : { updated: true, version }
  } catch (error) {
    if (error instanceof CliError) throw error
    if (error instanceof Deno.errors.PermissionDenied) {
      throw new CliError("The current Linear CLI binary is not writable", {
        suggestion:
          "Reinstall with mise or rerun with permission to update the binary.",
        cause: error,
      })
    }
    throw new CliError("Could not replace the current Linear CLI binary", {
      suggestion:
        "The installed binary was not changed. Reinstall it manually.",
      cause: error,
    })
  } finally {
    await removeIfExists(replacementPath)
  }
}

export const updateCommand = new Command()
  .name("update")
  .description("Update the Linear CLI")
  .option(
    "--bump",
    "Allow mise to update a pinned version selector",
  )
  .action(async ({ bump }) => {
    try {
      if (denoConfig.version === DEVELOPMENT_VERSION) {
        throw new CliError("Development builds cannot update themselves", {
          suggestion: "Install a release with mise or GitHub Releases.",
        })
      }

      const executablePath = Deno.execPath()
      if (await isMiseManagedInstallation({ executablePath })) {
        await updateWithMise("mise", bump)
        console.log(success("✓ mise finished updating Linear CLI"))
        return
      }

      const result = await updateStandaloneInstallation({
        executablePath,
        currentVersion: denoConfig.version,
        target: Deno.build.target,
        os: Deno.build.os,
      })
      if (!result.updated) {
        console.log(`Linear CLI is already up to date (${result.version})`)
        return
      }

      console.log(success(`✓ Updated Linear CLI to ${result.version}`))
      if (result.staleBackupPath) {
        console.error(
          warning(
            `Warning: Windows kept the previous binary at ${result.staleBackupPath}; it can be removed after this process exits.`,
          ),
        )
      }
    } catch (error) {
      handleError(error, "Failed to update Linear CLI")
    }
  })
