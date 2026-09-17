import { parse, stringify } from "@std/toml"
import { dirname, join } from "@std/path"
import { ensureDir } from "@std/fs"
import { yellow } from "@std/fmt/colors"
import { deletePassword, getPassword, setPassword } from "./keyring/index.ts"
import { withTerminalColors } from "./utils/terminal.ts"
import { AuthError, ValidationError } from "./utils/errors.ts"

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function writeCredentialsFile(
  path: string,
  content: string,
): Promise<void> {
  if (Deno.build.os !== "windows") {
    try {
      await Deno.chmod(path, 0o600)
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error
      }
    }
  }

  await Deno.writeTextFile(path, content, { mode: 0o600 })

  if (Deno.build.os !== "windows") {
    await Deno.chmod(path, 0o600)
  }
}

export interface Credentials {
  default?: string
  workspaces: string[]
}

let credentials: Credentials = { workspaces: [] }
let isInlineFormat = false
let loaded = false

const apiKeyCache = new Map<string, string>()

function ensureCredentials(): void {
  if (!loaded) loadCredentials()
}

/**
 * Get the path to the credentials file.
 * Follows XDG Base Directory Specification on Unix-like systems,
 * and uses APPDATA on Windows.
 */
export function getCredentialsPath(): string | null {
  if (Deno.build.os === "windows") {
    const appData = Deno.env.get("APPDATA")
    if (appData) {
      return join(appData, "linear", "credentials.toml")
    }
  } else {
    const xdgConfigHome = Deno.env.get("XDG_CONFIG_HOME")
    const homeDir = Deno.env.get("HOME")
    if (xdgConfigHome) {
      return join(xdgConfigHome, "linear", "credentials.toml")
    } else if (homeDir) {
      return join(homeDir, ".config", "linear", "credentials.toml")
    }
  }
  return null
}

interface InlineCredentials {
  default?: string
  [workspace: string]: string | undefined
}

// The inline format stores API keys directly in the TOML file as
// `workspace-name = "lin_api_..."`. The keyring format uses a `workspaces`
// array and stores keys in the OS keyring instead.
function hasInlineKeys(
  parsed: Record<string, unknown>,
): parsed is InlineCredentials {
  for (const [key, value] of Object.entries(parsed)) {
    if (key === "default") continue
    if (key === "workspaces") return false
    if (typeof value === "string") return true
  }
  return false
}

function parseInlineCredentials(parsed: InlineCredentials): Credentials {
  const workspaces: string[] = []
  for (const [key, value] of Object.entries(parsed)) {
    if (key === "default") continue
    if (typeof value === "string") {
      workspaces.push(key)
      apiKeyCache.set(key, value)
    }
  }
  return {
    default: typeof parsed.default === "string" ? parsed.default : undefined,
    workspaces,
  }
}

function parseKeyringCredentials(parsed: Record<string, unknown>): Credentials {
  const workspaces = Array.isArray(parsed.workspaces)
    ? [
      ...new Set((parsed.workspaces as unknown[]).filter((v): v is string =>
        typeof v === "string"
      )),
    ]
    : []

  const defaultWs = typeof parsed.default === "string"
    ? parsed.default
    : undefined
  const defaultIsValid = defaultWs != null && workspaces.includes(defaultWs)

  if (defaultWs != null && !defaultIsValid) {
    withTerminalColors(Deno.stderr, () =>
      console.error(
        yellow(
          `Warning: Default workspace "${defaultWs}" is not in the workspaces list. ` +
            `Run \`linear auth default <workspace>\` to set a valid default.`,
        ),
      ))
  }

  return {
    default: defaultIsValid ? defaultWs : undefined,
    workspaces,
  }
}

/**
 * Read local inventory only. Keyring secrets are resolved for one selected
 * workspace, never during module import or inventory listing.
 */
export function loadCredentials(): Credentials {
  const path = getCredentialsPath()
  if (!path) {
    credentials = { workspaces: [] }
    apiKeyCache.clear()
    isInlineFormat = false
    loaded = true
    return credentials
  }

  let file: string
  try {
    file = Deno.readTextFileSync(path)
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      credentials = { workspaces: [] }
      apiKeyCache.clear()
      isInlineFormat = false
      loaded = true
      return credentials
    }
    throw new AuthError(
      `Failed to read credentials file at ${path}`,
    )
  }

  let parsed: Record<string, unknown>
  try {
    parsed = parse(file) as Record<string, unknown>
  } catch {
    throw new AuthError(
      `Failed to parse credentials file at ${path}. Repair the file before changing credentials.`,
    )
  }

  const keyringFormat = Object.hasOwn(parsed, "workspaces")
  if (
    (parsed.default !== undefined && typeof parsed.default !== "string") ||
    (keyringFormat && (!Array.isArray(parsed.workspaces) ||
      !parsed.workspaces.every((workspace) =>
        typeof workspace === "string" && workspace !== ""
      ))) ||
    Object.entries(parsed).some(([key, value]) =>
      key !== "default" &&
      (keyringFormat
        ? key !== "workspaces"
        : typeof value !== "string" || value === "")
    )
  ) {
    throw new AuthError(
      `Invalid credentials file at ${path}. Repair the file before changing credentials.`,
    )
  }

  apiKeyCache.clear()

  if (hasInlineKeys(parsed)) {
    isInlineFormat = true
    credentials = parseInlineCredentials(parsed)
    loaded = true
    return credentials
  }

  isInlineFormat = false

  credentials = parseKeyringCredentials(parsed)
  loaded = true
  return credentials
}

/**
 * Save credentials to the credentials file.
 */
async function saveCredentials(): Promise<void> {
  const path = getCredentialsPath()
  if (!path) {
    throw new Error("Could not determine credentials path")
  }

  // Ensure the directory exists
  const dir = dirname(path)
  await ensureDir(dir)

  // Build a clean object for serialization
  // Put default first, then workspaces in alphabetical order
  const ordered: Record<string, unknown> = {}
  if (credentials.default != null) {
    ordered.default = credentials.default
  }
  ordered.workspaces = [...credentials.workspaces].sort()

  await writeCredentialsFile(path, stringify(ordered))
}

/**
 * Save credentials in inline (plaintext) format, storing the API key
 * directly in the TOML file rather than in the system keyring.
 */
async function saveInlineCredentials(
  workspace: string,
  apiKey: string,
): Promise<void> {
  const path = getCredentialsPath()
  if (!path) {
    throw new Error("Could not determine credentials path")
  }

  const dir = dirname(path)
  await ensureDir(dir)

  const ordered: Record<string, string> = {}
  if (credentials.default != null) {
    ordered.default = credentials.default
  }
  for (const ws of [...credentials.workspaces].sort()) {
    const key = ws === workspace ? apiKey : apiKeyCache.get(ws)
    if (key == null) {
      throw new Error(
        `Cannot save inline credentials: API key for workspace "${ws}" is missing from cache`,
      )
    }
    ordered[ws] = key
  }

  await writeCredentialsFile(path, stringify(ordered))
}

/**
 * Save all current inline credentials from cache.
 * Used when modifying the workspace list (remove, set default) in inline mode.
 */
async function saveAllInlineCredentials(): Promise<void> {
  const path = getCredentialsPath()
  if (!path) {
    throw new Error("Could not determine credentials path")
  }

  const dir = dirname(path)
  await ensureDir(dir)

  const ordered: Record<string, string> = {}
  if (credentials.default != null) {
    ordered.default = credentials.default
  }
  for (const ws of [...credentials.workspaces].sort()) {
    const key = apiKeyCache.get(ws)
    if (key == null) {
      throw new Error(
        `Cannot save inline credentials: API key for workspace "${ws}" is missing from cache`,
      )
    }
    ordered[ws] = key
  }

  await writeCredentialsFile(path, stringify(ordered))
}

/**
 * Migrate all inline (plaintext) credentials to the system keyring.
 * Returns the list of workspaces that were migrated.
 */
export async function migrateToKeyring(): Promise<string[]> {
  ensureCredentials()
  if (!isInlineFormat) {
    return []
  }

  // Explicit migration may inspect its entire input, unlike login or list.
  // Never overwrite an independently stored key or delete it during rollback.
  const existing = new Set<string>()
  for (const ws of credentials.workspaces) {
    const stored = await getPassword(ws)
    if (stored == null) continue
    if (stored !== apiKeyCache.get(ws)) {
      throw new AuthError(
        `Keyring already contains a different credential for workspace "${ws}"`,
      )
    }
    existing.add(ws)
  }
  const migrated: string[] = []
  for (const ws of credentials.workspaces) {
    if (existing.has(ws)) continue
    const key = apiKeyCache.get(ws)
    if (key == null) continue
    try {
      await setPassword(ws, key)
      migrated.push(ws)
    } catch (error) {
      // Roll back already-written keyring entries (best effort)
      for (const written of migrated) {
        try {
          await deletePassword(written)
        } catch {
          // best effort cleanup
        }
      }
      throw new Error(
        `Failed to store API key in system keyring for workspace "${ws}": ${
          errorDetail(error)
        }. Rolled back ${migrated.length} already-written entries.`,
      )
    }
  }

  await saveCredentials()
  isInlineFormat = false
  return [...credentials.workspaces]
}

/**
 * Check whether the current credentials file uses inline (plaintext) format.
 */
export function isUsingInlineFormat(): boolean {
  ensureCredentials()
  return isInlineFormat
}

/**
 * Add or update a credential.
 * If this is the first workspace, it becomes the default.
 * When `plaintext` is true, the key is stored directly in the TOML file.
 * When not specified, preserves the current credential format.
 */
export async function addCredential(
  workspace: string,
  apiKey: string,
  options?: { plaintext?: boolean },
): Promise<void> {
  ensureCredentials()
  const useInline = options?.plaintext ?? isInlineFormat

  if (credentials.workspaces.length > 0 && useInline !== isInlineFormat) {
    throw new ValidationError("Cannot change credential storage during login", {
      suggestion: isInlineFormat
        ? "Run `linear auth migrate` to explicitly migrate all plaintext credentials to the keyring."
        : "Omit --plaintext to preserve existing keyring credentials.",
    })
  }

  if (!useInline) {
    try {
      await setPassword(workspace, apiKey)
    } catch (error) {
      throw new Error(
        `Failed to store API key in system keyring for workspace "${workspace}": ${
          errorDetail(error)
        }`,
      )
    }
  }

  apiKeyCache.set(workspace, apiKey)

  const isNew = !credentials.workspaces.includes(workspace)
  if (isNew) {
    credentials.workspaces.push(workspace)
  }

  // If this is the first workspace, make it the default
  if (isNew && credentials.workspaces.length === 1) {
    credentials.default = workspace
  }

  if (useInline) {
    await saveInlineCredentials(workspace, apiKey)
  } else {
    await saveCredentials()
  }
  isInlineFormat = useInline
}

/**
 * Remove a credential.
 * If removing the default, reassign to another workspace or clear.
 */
export async function removeCredential(workspace: string): Promise<void> {
  ensureCredentials()
  if (!isInlineFormat) {
    try {
      await deletePassword(workspace)
    } catch (error) {
      throw new Error(
        `Failed to remove API key from system keyring for workspace "${workspace}": ${
          errorDetail(error)
        }`,
      )
    }
  }
  apiKeyCache.delete(workspace)

  credentials.workspaces = credentials.workspaces.filter((w) => w !== workspace)

  // If we removed the default, reassign it
  if (credentials.default === workspace) {
    credentials.default = credentials.workspaces[0]
  }

  if (isInlineFormat) {
    await saveAllInlineCredentials()
  } else {
    await saveCredentials()
  }
}

/**
 * Set the default workspace.
 */
export async function setDefaultWorkspace(workspace: string): Promise<void> {
  ensureCredentials()
  if (!credentials.workspaces.includes(workspace)) {
    throw new Error(`Workspace "${workspace}" not found in credentials`)
  }
  credentials.default = workspace

  if (isInlineFormat) {
    await saveAllInlineCredentials()
  } else {
    await saveCredentials()
  }
}

/**
 * Get the API key for a workspace, or the default if not specified.
 */
export async function getCredentialApiKey(
  workspace?: string,
): Promise<string | undefined> {
  ensureCredentials()
  const selected = workspace ?? credentials.default
  if (selected == null || !credentials.workspaces.includes(selected)) return
  const cached = apiKeyCache.get(selected)
  if (cached != null) return cached
  let key: string | null
  try {
    key = await getPassword(selected)
  } catch {
    throw new AuthError(
      `Could not read keyring credential for workspace "${selected}"`,
    )
  }
  if (key == null || key === "") {
    throw new AuthError(`No keyring credential for workspace "${selected}"`)
  }
  apiKeyCache.set(selected, key)
  return key
}

/**
 * Get the current default workspace slug.
 */
export function getDefaultWorkspace(): string | undefined {
  ensureCredentials()
  return credentials.default
}

/**
 * Get all configured workspaces.
 */
export function getWorkspaces(): string[] {
  ensureCredentials()
  return [...credentials.workspaces]
}

/**
 * Check if a workspace is configured.
 */
export function hasWorkspace(workspace: string): boolean {
  ensureCredentials()
  return credentials.workspaces.includes(workspace)
}
