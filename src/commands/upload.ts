import { Command } from "@cliffy/command"
import { handleError } from "../utils/errors.ts"
import {
  formatAsMarkdownLink,
  getMimeType,
  resolveMakePublic,
  uploadFile,
  type UploadResult,
  validateFilePath,
} from "../utils/upload.ts"
import { withUsageMetadata } from "./usage.ts"

// `upload` is the rich-text primitive: it turns local files into Linear asset
// URLs that Markdown can embed anywhere — descriptions, comments, table
// cells. The three-step upload dance (fileUpload mutation → signed PUT →
// assetUrl) plus public/private semantics is exactly the plumbing an agent
// would otherwise rebuild against raw GraphQL, which is why this command
// exists; composing the returned URL into Markdown stays with the caller
// (design: docs/agent-interface-architecture.md, "上传原语与富文本").
//
// Every file is validated — existence, type, public eligibility — before the
// first network request, mirroring the delivery protocol's
// validate-before-first-mutation rule, so a bad third file cannot leave a
// half-finished batch behind by surprise.

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
