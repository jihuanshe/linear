import { Command } from "@cliffy/command"
import denoConfig from "../../deno.json" with { type: "json" }

const DISTRIBUTION = "jihuanshe/linear"
const CAPABILITIES = ["usage-v1"] as const

/**
 * Version JSON v1 is additive: readers must ignore unknown fields and
 * capability identifiers. Removing or retyping a field requires a schema
 * version increment.
 */
export interface VersionDocument {
  schemaVersion: 1
  distribution: string
  version: string
  capabilities: string[]
}

export const versionCommand = new Command()
  .description("Show build identity and protocol capabilities")
  .option("--json", "Output machine-readable build identity")
  .action(({ json }) => {
    const document: VersionDocument = {
      schemaVersion: 1,
      distribution: DISTRIBUTION,
      version: denoConfig.version,
      capabilities: [...CAPABILITIES],
    }
    console.log(
      json ? JSON.stringify(document, null, 2) : [
        `distribution: ${document.distribution}`,
        `version: ${document.version}`,
        `capabilities: ${document.capabilities.join(", ")}`,
      ].join("\n"),
    )
  })
