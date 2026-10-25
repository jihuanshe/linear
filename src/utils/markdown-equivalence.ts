import { unified } from "unified"
import remarkParse from "remark-parse"
import remarkGfm from "remark-gfm"
import { visit } from "unist-util-visit"

const parser = unified().use(remarkParse).use(remarkGfm)

type Tree = ReturnType<typeof parser.parse>
type Child = Tree["children"][number]

/**
 * Linear links bare domains on save: `notes.example.com` reads back as
 * `[notes.example.com](<http://notes.example.com>)`. Only a link whose sole
 * text is its own URL without `http://` counts as that rewrite; its text
 * stays, so changed wording still differs.
 */
function autoLinkText(node: Child): string | undefined {
  if (node.type !== "link" || node.title != null) return undefined
  if (!node.url.startsWith("http://") || node.children.length !== 1) {
    return undefined
  }
  const [text] = node.children
  return text.type === "text" && text.value === node.url.slice(7)
    ? text.value
    : undefined
}

function comparableMarkdown(markdown: string): string {
  const tree = parser.parse(markdown)
  visit(tree, (node) => {
    delete node.position
    if ("children" in node) {
      const children: Child[] = node.children
      for (let index = 0; index < children.length; index++) {
        const value = autoLinkText(children[index])
        if (value != null) children[index] = { type: "text", value }
      }
      // Rejoin the text around an unwrapped link into one node.
      for (let index = 1; index < children.length;) {
        const previous = children[index - 1]
        const current = children[index]
        if (previous.type === "text" && current.type === "text") {
          previous.value += current.value
          children.splice(index, 1)
        } else {
          index++
        }
      }
    }
    // Linear joins adjacent unordered lists split by different bullet markers.
    // Merge parsed siblings, not source text: rewriting '* ---' as '- ---'
    // would turn a list item into a top-level thematic break.
    if ("children" in node) {
      for (let index = 1; index < node.children.length;) {
        const previous = node.children[index - 1]
        const current = node.children[index]
        if (
          previous.type === "list" && !previous.ordered &&
          current.type === "list" && !current.ordered
        ) {
          previous.children.push(...current.children)
          previous.spread ||= current.spread
          node.children.splice(index, 1)
        } else {
          index++
        }
      }
    }
    if (
      node.type === "link" || node.type === "image" ||
      node.type === "definition"
    ) {
      try {
        node.url = node.url.replace(
          /\P{ASCII}+/gu,
          (text) => encodeURI(text),
        )
      } catch {
        // Unpaired Unicode surrogates remain literal URL content.
      }
    }
    // Linear rewrites blank separators between single-paragraph list items.
    if (
      node.type === "list" &&
      node.children.every((item) =>
        item.children.length === 1 && item.children[0].type === "paragraph"
      )
    ) {
      node.spread = false
      for (const item of node.children) item.spread = false
    }
  })
  return JSON.stringify(tree)
}

/**
 * How Markdown read back after a write matches what was sent: `exact` bytes,
 * `normalized` when it differs only by the rewrites Linear applies on save
 * (bullet markers, `(<url>)` link destinations, percent-encoded URLs, blank
 * lines between list items, trailing whitespace and auto-linked bare
 * domains), or `different`. Original-value guards stay exact.
 */
export function compareMarkdown(
  expected: string,
  actual: string,
): "exact" | "normalized" | "different" {
  if (expected === actual) return "exact"
  return comparableMarkdown(expected) === comparableMarkdown(actual)
    ? "normalized"
    : "different"
}
