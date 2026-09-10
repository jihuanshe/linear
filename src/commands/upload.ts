import { Command } from "@cliffy/command"
import { handleError, withAppliedReceipts } from "../utils/errors.ts"
import { printWriteResult } from "../utils/write-result.ts"
import {
  formatAsMarkdownLink,
  prepareUploads,
  uploadFile,
  type UploadResult,
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
      const results: UploadResult[] = []
      try {
        const prepared = await prepareUploads(files, {
          makePublic: options.public,
        })

        for (const file of prepared) {
          results.push(
            await uploadFile(file.filepath, {
              makePublic: options.public,
              showProgress: !options.json,
              expectedSha256: file.sha256,
            }),
          )
        }

        if (options.json) {
          printWriteResult(results)
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
        handleError(
          withAppliedReceipts(
            error,
            results.map((result) => ({ kind: "upload", ...result })),
          ),
          "Failed to upload files",
        )
      }
    }),
  { writes: true },
)
