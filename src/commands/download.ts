import { Command } from "@cliffy/command"
import { downloadFile } from "../utils/download.ts"
import { handleError } from "../utils/errors.ts"
import { withUsageMetadata } from "./usage.ts"

export const downloadCommand = withUsageMetadata(
  new Command()
    .description(
      "Download a Linear asset and verify its SHA-256",
    )
    .arguments("<asset-url:string>")
    .option(
      "--output <path:string>",
      "New output file (parent directory must exist)",
      { required: true },
    )
    .option(
      "--sha256 <hash:string>",
      "Require this SHA-256 before publishing the output file",
    )
    .option(
      "--json",
      "Output asset URL, absolute path, byte size and SHA-256 as JSON",
    )
    .action(async (options, assetUrl) => {
      try {
        const result = await downloadFile(
          assetUrl,
          options.output,
          options.sha256,
        )
        console.log(
          options.json
            ? JSON.stringify(result, null, 2)
            : `${result.path} (${result.size} bytes)\nSHA-256: ${result.sha256}`,
        )
      } catch (error) {
        handleError(error, "Failed to download asset")
      }
    }),
  { writes: false },
)
