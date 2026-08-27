import { Command } from "@cliffy/command"
import { getGuide, listGuides } from "../../guides/guides.ts"
import {
  handleError,
  NotFoundError,
  ValidationError,
} from "../../utils/errors.ts"

// `guide` is the concise index, while `guide <name>` prints one Markdown body
// to stdout and nothing else, so both compose with shell tools. No guide
// command touches the network or credentials: the corpus is embedded in the
// binary (see src/guides/content.ts). Discovery stays optional — an agent
// that already knows its command never needs to read a guide first.

function formatGuideList(): string {
  const guides = listGuides()
  const width = Math.max(...guides.map((guide) => guide.metadata.name.length))
  const lines = guides.map((guide) =>
    `  ${guide.metadata.name.padEnd(width + 2)}${guide.metadata.description}`
  )
  return [
    "Version-matched workflow guides:",
    ...lines,
    "",
    "read: linear guide <name>",
    "machine-readable: linear guide --json",
  ].join("\n")
}

function guideListDocument() {
  return listGuides().map((guide) => guide.metadata)
}

export const guideCommand = new Command()
  .description("Read version-matched workflow guides")
  .arguments("[name:string]")
  .option("--json", "Output guide metadata as JSON")
  .action(({ json }, name?: string) => {
    try {
      if (name == null) {
        console.log(
          json
            ? JSON.stringify(guideListDocument(), null, 2)
            : formatGuideList(),
        )
        return
      }
      if (json) {
        throw new ValidationError("Guide name cannot be used with --json")
      }
      const guide = getGuide(name)
      if (guide == null) {
        const names = listGuides().map((item) => item.metadata.name).join(", ")
        throw new NotFoundError("Guide", name, {
          suggestion: `Available guides: ${names}`,
        })
      }
      console.log(guide.body.trimEnd())
    } catch (error) {
      handleError(error, "Failed to read guide")
    }
  })
