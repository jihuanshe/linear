import { Command } from "@cliffy/command"
import { handleError, ValidationError } from "../utils/errors.ts"
import {
  formatAsMarkdownLink,
  getMimeType,
  MAX_FILE_SIZE,
  resolveMakePublic,
  uploadFile,
  type UploadResult,
  validateFilePath,
} from "../utils/upload.ts"
import { withUsageMetadata } from "./usage.ts"

// Upload local files, validate the complete batch before the first request,
// and print asset URLs for callers to embed in Markdown.

function formatResult(result: UploadResult): string {
  const visibility = result.public ? "public" : "private"
  const size = `${(result.size / 1024).toFixed(1)}KB`
  return [
    `${result.filename} (${size}, ${result.contentType}, ${visibility})`,
    `  url: ${result.assetUrl}`,
    `  markdown: ${formatAsMarkdownLink(result)}`,
  ].join("\n")
}

export const uploadCommand = withUsageMetadata(
  new Command()
    .description(
      "Upload files to Linear storage and print their asset URLs for embedding in Markdown",
    )
    .arguments("<files...:string>")
    .option(
      "--public",
      "Create unauthenticated public URLs (raster images only; other types fail)",
    )
    .option("--json", "Output upload results as JSON")
    .action(async (options, ...files: string[]) => {
      try {
        for (const file of files) {
          await validateFilePath(file)
          const info = await Deno.stat(file)
          if (info.size > MAX_FILE_SIZE) {
            throw new ValidationError(
              `File too large: ${file} (max ${MAX_FILE_SIZE / 1024 / 1024}MB)`,
              { suggestion: "Please upload a file smaller than 100MB" },
            )
          }
          resolveMakePublic(getMimeType(file), options.public)
        }

        const results: UploadResult[] = []
        for (const file of files) {
          results.push(
            await uploadFile(file, {
              makePublic: options.public,
              showProgress: !options.json,
            }),
          )
        }

        if (options.json) {
          console.log(JSON.stringify(results, null, 2))
          return
        }
        for (const result of results) {
          console.log(formatResult(result))
        }
        if (results.some((result) => result.public)) {
          console.error(
            "⚠ Public URLs are readable by anyone without authentication",
          )
        }
      } catch (error) {
        handleError(error, "Failed to upload files")
      }
    }),
  { writes: true },
)
