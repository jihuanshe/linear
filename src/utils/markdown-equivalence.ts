import { unified } from "unified"
import remarkParse from "remark-parse"
import remarkGfm from "remark-gfm"
import { visit } from "unist-util-visit"

const parser = unified().use(remarkParse).use(remarkGfm)

function comparableMarkdown(markdown: string): string {
  let tree = parser.parse(markdown)
  // Different bullet markers split adjacent items into separate Markdown lists.
  // Normalize only parsed item markers; code and inline text stay untouched.
  const characters = markdown.split("")
  let changed = false
  visit(tree, "list", (list) => {
    if (list.ordered) return
    for (const item of list.children) {
      const offset = item.position?.start.offset
      if (offset != null && /[+*]/.test(characters[offset])) {
        characters[offset] = "-"
        changed = true
      }
    }
  })
  if (changed) tree = parser.parse(characters.join(""))
  visit(tree, (node) => {
    delete node.position
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
