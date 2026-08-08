import { Command } from "@cliffy/command"
import { getGuide, listGuides } from "../../guides/guides.ts"
import { handleError, NotFoundError } from "../../utils/errors.ts"

// `guides list` is the concise index, `guides read` prints one Markdown body
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
    "read: linear guides read <name>",
    "machine-readable: linear guides list --json",
  ].join("\n")
}

function guideListDocument() {
  return listGuides().map((guide) => guide.metadata)
}

const listCommand = new Command()
  .description("List version-matched workflow guides")
  .option("--json", "Output guide metadata as JSON")
  .action(({ json }) => {
    console.log(
      json ? JSON.stringify(guideListDocument(), null, 2) : formatGuideList(),
    )
  })

const readCommand = new Command()
  .description("Print one guide's Markdown body to stdout")
  .arguments("<name:string>")
  .action((_options, name: string) => {
    try {
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

export const guidesCommand = new Command()
  .description("Version-matched workflow guides")
  .action(() => {
    console.log(formatGuideList())
  })
  .command("list", listCommand)
  .command("read", readCommand)
