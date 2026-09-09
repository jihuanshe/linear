// Guides ship inside the binary with the CLI that implements their commands
// (design: docs/agent-interface-architecture.md, "文档与验证"). Static text imports
// are the embedding mechanism: `deno compile`
// bundles each file into the executable, so `guide <name>` works without
// repository files or network access.
//
// Cross-command workflow knowledge belongs here; a fact one command
// can state alone belongs in that command's description instead.
import automation from "../../docs/guides/automation.md" with { type: "text" }
import core from "../../docs/guides/core.md" with { type: "text" }
import doctor from "../../docs/guides/doctor.md" with { type: "text" }
import graphql from "../../docs/guides/graphql.md" with { type: "text" }
import issueAuthoring from "../../docs/guides/issue-authoring.md" with {
  type: "text",
}
import issueDelivery from "../../docs/guides/issue-delivery.md" with {
  type: "text",
}
import markdown from "../../docs/guides/markdown.md" with { type: "text" }

/**
 * Import manifest of every embedded guide, in display order. A test compares
 * these keys with `docs/guides/*.md` so a new source file cannot be silently
 * left out of the compiled binary.
 */
export const guideSources: Record<string, string> = {
  "core": core,
  "automation": automation,
  "issue-authoring": issueAuthoring,
  "issue-delivery": issueDelivery,
  "graphql": graphql,
  "doctor": doctor,
  "markdown": markdown,
}
