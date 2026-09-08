import { createHash } from "node:crypto"
import { dirname, resolve } from "@std/path"
import { getResolvedApiKey } from "./graphql.ts"
import { AuthError, CliError, ValidationError } from "./errors.ts"

export interface DownloadResult {
  assetUrl: string
  path: string
  size: number
  sha256: string
}

/** Download a Linear asset afresh; publish the file only after verification. */
export async function downloadFile(
  assetUrl: string,
  output: string,
  expectedSha256?: string,
): Promise<DownloadResult> {
  let url: URL
  try {
    url = new URL(assetUrl)
  } catch {
    throw new ValidationError("Expected an HTTPS uploads.linear.app asset URL")
  }
  if (
    url.origin !== "https://uploads.linear.app" || url.username || url.password
  ) {
    throw new ValidationError("Expected an HTTPS uploads.linear.app asset URL")
  }
  if (expectedSha256 != null && !/^[a-f0-9]{64}$/i.test(expectedSha256)) {
    throw new ValidationError(
      "--sha256 must contain exactly 64 hexadecimal digits",
    )
  }
  const path = resolve(output)
  try {
    await Deno.lstat(path)
    throw new ValidationError(`Output already exists: ${path}`)
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error
  }
  const key = getResolvedApiKey()
  if (!key) throw new AuthError("No API key configured")
  const temporary = await Deno.makeTempFile({
    dir: dirname(path),
    prefix: ".linear-download-",
  })
  try {
    let response: Response | undefined
    // A redirect may point at signed object storage. Credentials belong only
    // to the original Linear request, never to a redirect destination.
    for (let redirects = 0; redirects <= 5; redirects++) {
      response = await fetch(url, {
        redirect: "manual",
        headers: redirects === 0 ? { Authorization: key } : {},
        signal: AbortSignal.timeout(120_000),
      })
      if (![301, 302, 303, 307, 308].includes(response.status)) break
      await response.body?.cancel()
      const location = response.headers.get("location")
      if (!location || redirects === 5) {
        throw new CliError("Invalid or excessive asset redirects")
      }
      url = new URL(location, url)
      if (url.protocol !== "https:" || url.username || url.password) {
        throw new CliError(
          "Asset redirect must use HTTPS without embedded credentials",
        )
      }
    }
    if (!response?.ok || !response.body) {
      await response?.body?.cancel()
      throw new CliError(`Asset download failed (HTTP ${response?.status})`)
    }
    const hash = createHash("sha256")
    let size = 0
    const file = await Deno.open(temporary, { write: true, truncate: true })
    await response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          hash.update(chunk)
          size += chunk.byteLength
          controller.enqueue(chunk)
        },
      }),
    ).pipeTo(file.writable)
    const sha256 = hash.digest("hex")
    if (expectedSha256 != null && sha256 !== expectedSha256.toLowerCase()) {
      throw new CliError(
        `SHA-256 mismatch: expected ${expectedSha256.toLowerCase()}, received ${sha256}`,
      )
    }
    // Same-directory hard link publishes atomically without overwriting a file
    // that another process may have created since the initial existence check.
    await Deno.link(temporary, path)
    return { assetUrl, path, size, sha256 }
  } finally {
    await Deno.remove(temporary)
  }
}
