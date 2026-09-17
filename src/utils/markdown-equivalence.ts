import { unified } from "unified"
import remarkParse from "remark-parse"
import remarkGfm from "remark-gfm"
import { visit } from "unist-util-visit"

const parser = unified().use(remarkParse).use(remarkGfm)

function comparableMarkdown(markdown: string): string {
  const tree = parser.parse(markdown)
  visit(tree, (node) => {
    delete node.position
    // Linear joins adjacent unordered lists split by different bullet markers.
    // Merge parsed siblings, not source text: rewriting '* ---' as '- ---'
    // would turn a list item into a top-level thematic break.
    // https://linear.app/jihuanshe/issue/ARCH-231
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

/** Compare Markdown read back after a write; original-value guards stay exact. */
export function equivalentMarkdown(expected: string, actual: string): boolean {
  return expected === actual ||
    comparableMarkdown(expected) === comparableMarkdown(actual)
}
