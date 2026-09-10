import { Command } from "@cliffy/command"
import denoConfig from "../../deno.json" with { type: "json" }

const DISTRIBUTION = "jihuanshe/linear"

/** Build identity; command capabilities come from the actual usage tree. */
export interface VersionDocument {
  distribution: string
  version: string
}

export const versionCommand = new Command()
  .description("Show the CLI distribution and build version")
  .option("--json", "Output machine-readable build identity")
  .action(({ json }) => {
    const document: VersionDocument = {
      distribution: DISTRIBUTION,
      version: denoConfig.version,
    }
    console.log(
      json ? JSON.stringify(document, null, 2) : [
        `distribution: ${document.distribution}`,
        `version: ${document.version}`,
      ].join("\n"),
    )
  })
