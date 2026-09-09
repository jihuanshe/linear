import { gql } from "../__codegen__/gql.ts"
import { getGraphQLClient } from "./graphql.ts"
import { basename, extname } from "@std/path"
import {
  assertMutationSuccess,
  errorResult,
  isClientError,
  NotFoundError,
  ValidationError,
  WriteError,
} from "./errors.ts"
import { encodeHex } from "@std/encoding/hex"
import { Spinner } from "@std/cli/unstable-spinner"
import { shouldShowSpinner } from "./hyperlink.ts"

/**
 * MIME type mapping for common file extensions
 */
const MIME_TYPES: Record<string, string> = {
  // Images
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".bmp": "image/bmp",
  ".tiff": "image/tiff",
  ".tif": "image/tiff",

  // Documents
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx":
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",

  // Text
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".html": "text/html",
  ".htm": "text/html",
  ".css": "text/css",
  ".xml": "text/xml",

  // Code
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".ts": "text/typescript",
  ".tsx": "text/typescript",
  ".jsx": "text/javascript",
  ".json": "application/json",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
  ".toml": "text/toml",
  ".sh": "text/x-shellscript",
  ".bash": "text/x-shellscript",
  ".py": "text/x-python",
  ".rb": "text/x-ruby",
  ".go": "text/x-go",
  ".rs": "text/x-rust",
  ".java": "text/x-java",
  ".c": "text/x-c",
  ".cpp": "text/x-c++",
  ".h": "text/x-c",
  ".hpp": "text/x-c++",

  // Archives
  ".zip": "application/zip",
  ".tar": "application/x-tar",
  ".gz": "application/gzip",
  ".7z": "application/x-7z-compressed",
  ".rar": "application/vnd.rar",

  // Audio
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",

  // Video
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".avi": "video/x-msvideo",

  // Other
  ".wasm": "application/wasm",
}

/**
 * Maximum file size for uploads (100MB)
 */
export const MAX_FILE_SIZE = 100 * 1024 * 1024

/**
 * Get MIME type from file extension
 */
export function getMimeType(filepath: string): string {
  const ext = extname(filepath).toLowerCase()
  return MIME_TYPES[ext] || "application/octet-stream"
}

/**
 * Result of a successful file upload
 */
export interface UploadResult {
  /** The permanent URL where the file is accessible */
  assetUrl: string
  /** The original filename */
  filename: string
  /** The file size in bytes */
  size: number
  /** The MIME type of the file */
  contentType: string
  /** Whether the file was uploaded to a public, unauthenticated URL */
  public: boolean
}

/**
 * Options for file upload
 */
export interface UploadOptions {
  /**
   * Upload the file to a public, unauthenticated URL. Only supported for raster
   * images. Defaults to false (private, workspace-members only) to match the
   * Linear web app.
   */
  makePublic?: boolean
  /** Show progress indicator */
  showProgress?: boolean
  /** Pin the bytes validated by delivery before its first write. */
  expectedSha256?: string
  /** The delivery ledger records in-flight state immediately before sending. */
  beforeWrite?: () => Promise<void>
}

/**
 * Check if a file type can be uploaded as public
 * Linear only allows public uploads for images (excluding SVG)
 */
function canBePublic(contentType: string): boolean {
  const publicTypes = [
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/bmp",
    "image/tiff",
  ]
  return publicTypes.includes(contentType)
}

/**
 * Resolve the effective `makePublic` value for an upload.
 *
 * Uploads default to private (workspace-members only), matching Linear's web
 * app. Public is opt-in and only valid for raster image types — requesting it
 * for any other content type is an error rather than a silent downgrade.
 */
export function resolveMakePublic(
  contentType: string,
  requested?: boolean,
): boolean {
  const makePublic = requested ?? false
  if (makePublic && !canBePublic(contentType)) {
    throw new ValidationError(
      `Cannot upload ${contentType || "this file"} to a public URL`,
      {
        suggestion:
          "Linear only allows public uploads for raster images (png, jpeg, gif, webp, bmp, tiff). Remove --public to upload privately.",
      },
    )
  }
  return makePublic
}

async function readUploadBytes(filepath: string, requestedPublic?: boolean) {
  const fileInfo = await validateFilePath(filepath)
  if (fileInfo.size > MAX_FILE_SIZE) {
    throw new ValidationError(
      `File too large: ${filepath} (max ${MAX_FILE_SIZE / 1024 / 1024}MB)`,
      {
        suggestion: "Please upload a file smaller than 100MB",
      },
    )
  }
  const filename = basename(filepath)
  const contentType = getMimeType(filepath)
  const makePublic = resolveMakePublic(contentType, requestedPublic)
  const fileData = await Deno.readFile(filepath)
  const size = fileData.byteLength
  if (size > MAX_FILE_SIZE) {
    throw new ValidationError("File grew beyond the upload size limit")
  }
  return { filename, contentType, makePublic, fileData, size }
}

/** Validate the entire batch before its first write and pin each file's bytes. */
export async function prepareUploads(
  filepaths: readonly string[],
  options: Pick<UploadOptions, "makePublic"> = {},
): Promise<Array<{ filepath: string; sha256: string }>> {
  const prepared: Array<{ filepath: string; sha256: string }> = []
  for (const filepath of filepaths) {
    const { fileData } = await readUploadBytes(filepath, options.makePublic)
    prepared.push({
      filepath,
      sha256: encodeHex(await crypto.subtle.digest("SHA-256", fileData)),
    })
  }
  return prepared
}

/**
 * Upload a file to Linear's cloud storage
 *
 * This is a two-step process:
 * 1. Request a signed upload URL from Linear's GraphQL API
 * 2. Upload the file directly to the signed URL
 *
 * @param filepath - Path to the file to upload
 * @param options - Upload options
 * @returns The asset URL and file metadata
 */
export async function uploadFile(
  filepath: string,
  options: UploadOptions = {},
): Promise<UploadResult> {
  const { showProgress = false } = options

  // These exact checked bytes are sent after the grant; later edits cannot change them.
  const { filename, contentType, makePublic, fileData, size } =
    await readUploadBytes(filepath, options.makePublic)
  if (options.expectedSha256 != null) {
    const actual = encodeHex(await crypto.subtle.digest("SHA-256", fileData))
    if (actual !== options.expectedSha256) {
      throw new ValidationError(`File changed after validation: ${filepath}`)
    }
  }

  // Step 1: Request signed upload URL
  const mutation = gql(`
    mutation FileUpload($contentType: String!, $filename: String!, $size: Int!, $makePublic: Boolean) {
      fileUpload(contentType: $contentType, filename: $filename, size: $size, makePublic: $makePublic) {
        success
        uploadFile {
          assetUrl
          uploadUrl
          headers {
            key
            value
          }
        }
      }
    }
  `)

  const client = getGraphQLClient()
  const spinner = showProgress && shouldShowSpinner()
    ? new Spinner({ message: `Uploading ${filename}...` })
    : null
  spinner?.start()

  let grant: UploadResult | undefined
  let grantStarted = false
  let putStarted = false

  try {
    await options.beforeWrite?.()
    grantStarted = true
    const data = await client.request(mutation, {
      contentType,
      filename,
      size,
      makePublic,
    })

    // Signed PUT URLs and headers are capabilities, not diagnostic output.
    const acknowledgement = {
      fileUpload: { success: data?.fileUpload?.success },
    }
    assertMutationSuccess(data?.fileUpload, acknowledgement)
    if (!data.fileUpload.uploadFile) {
      throw new WriteError("Upload grant returned no upload details", {
        effect: "applied",
        data: acknowledgement,
      })
    }

    const { assetUrl, uploadUrl, headers } = data.fileUpload.uploadFile
    if (
      typeof assetUrl !== "string" || !assetUrl
    ) {
      throw new WriteError("Upload grant returned incomplete details", {
        effect: "applied",
        data: acknowledgement,
      })
    }
    grant = { assetUrl, filename, size, contentType, public: makePublic }
    if (
      typeof uploadUrl !== "string" || !uploadUrl || !Array.isArray(headers) ||
      !headers.every((header) =>
        header != null && typeof header.key === "string" &&
        typeof header.value === "string"
      )
    ) {
      throw new WriteError(
        "Upload grant returned incomplete transfer details",
        {
          effect: "applied",
        },
      )
    }

    // Build headers - start with Content-Type which is required by the signed URL
    const uploadHeaders: Record<string, string> = {
      "content-type": contentType,
    }

    // Add headers returned from Linear (may override content-type if provided)
    for (const header of headers) {
      uploadHeaders[header.key] = header.value
    }

    putStarted = true
    const response = await fetch(uploadUrl, {
      method: "PUT",
      headers: uploadHeaders,
      body: fileData,
    })

    if (!response.ok) {
      await response.body?.cancel()
      throw new WriteError(
        `Failed to upload file (HTTP ${response.status})`,
        { effect: "unknown" },
      )
    }

    spinner?.stop()

    return grant
  } catch (error) {
    spinner?.stop()
    // graphql-request includes partial response data in ClientError.stack.
    // Keep the safe grant metadata, never the signed URL, headers or raw cause.
    const failedPayload = isClientError(error)
      ? (error.response.data as {
        fileUpload?: { success?: unknown; uploadFile?: { assetUrl?: unknown } }
      } | undefined)?.fileUpload
      : undefined
    const partialAsset = failedPayload?.uploadFile?.assetUrl
    if (
      failedPayload?.success === true && typeof partialAsset === "string" &&
      partialAsset
    ) {
      grant = {
        assetUrl: partialAsset,
        filename,
        size,
        contentType,
        public: makePublic,
      }
    }
    if (grant != null) {
      throw new WriteError(
        error instanceof WriteError
          ? error.userMessage
          : putStarted
          ? "Upload transfer outcome is unknown"
          : "Upload grant could not be used",
        {
          effect: putStarted ? "unknown" : "applied",
          receipts: [{
            kind: "upload",
            stage: putStarted ? "unknown" : "signed",
            ...grant,
          }],
          suggestion:
            "A signed URL is not proof the bytes were stored; reconcile this upload before retrying.",
        },
      )
    }
    if (grantStarted) {
      const effect = failedPayload?.success === true
        ? "applied"
        : errorResult(error).effect
      throw new WriteError(
        error instanceof WriteError
          ? error.userMessage
          : "Upload grant request did not provide a usable receipt",
        {
          effect,
          suggestion:
            "Reconcile the upload grant before retrying; no file transfer was confirmed.",
        },
      )
    }
    throw error
  }
}

/**
 * Check if a file exists and is readable
 */
export async function validateFilePath(
  filepath: string,
): Promise<Deno.FileInfo> {
  try {
    const info = await Deno.stat(filepath)
    if (!info.isFile) {
      throw new ValidationError(`Not a file: ${filepath}`, {
        suggestion: "Please provide a path to a valid file",
      })
    }
    return info
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new NotFoundError("File", filepath)
    }
    throw error
  }
}

/**
 * Format an uploaded file as a markdown link
 */
export function formatAsMarkdownLink(
  result: Pick<UploadResult, "filename" | "assetUrl" | "contentType">,
): string {
  const isImage = result.contentType.startsWith("image/")
  if (isImage) {
    return `![${result.filename}](${result.assetUrl})`
  }
  return `[${result.filename}](${result.assetUrl})`
}
