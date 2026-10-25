import { assertEquals } from "@std/assert"
import { compareMarkdown } from "../../src/utils/markdown-equivalence.ts"

// A false "normalized" hides a lost edit; a false "different" makes callers
// reread or repeat a write that landed. Both directions are checked here.

Deno.test("compareMarkdown - identical bytes are exact", () => {
  assertEquals(compareMarkdown("- a\n", "- a\n"), "exact")
})

Deno.test("compareMarkdown - accepts Linear's auto-linked bare domain", () => {
  assertEquals(
    compareMarkdown(
      "部署在 notes.jihuanshe.com 上。\n",
      "部署在 [notes.jihuanshe.com](<http://notes.jihuanshe.com>) 上。",
    ),
    "normalized",
  )
  assertEquals(
    compareMarkdown(
      "notes.jihuanshe.com",
      "[notes.jihuanshe.com](<http://notes.jihuanshe.com>)",
    ),
    "normalized",
  )
  // A GFM www. literal is already a link when parsed; Linear writes it out.
  assertEquals(
    compareMarkdown(
      "见 www.jihuanshe.com",
      "见 [www.jihuanshe.com](<http://www.jihuanshe.com>)",
    ),
    "normalized",
  )
})

Deno.test("compareMarkdown - accepts Linear's Markdown serialization", () => {
  assertEquals(compareMarkdown("- a\n- b\n", "* a\n* b"), "normalized")
  assertEquals(
    compareMarkdown(
      "[文档](https://notes.jihuanshe.com/a)\n",
      "[文档](<https://notes.jihuanshe.com/a>)",
    ),
    "normalized",
  )
  assertEquals(compareMarkdown("结论\n", "结论"), "normalized")
  assertEquals(
    compareMarkdown(
      "notes.jihuanshe.com/中文",
      "[notes.jihuanshe.com/中文](<http://notes.jihuanshe.com/%E4%B8%AD%E6%96%87>)",
    ),
    "normalized",
  )
})

Deno.test("compareMarkdown - explicit links keep their structure", () => {
  assertEquals(
    compareMarkdown(
      "[notes.jihuanshe.com](http://notes.jihuanshe.com)\n",
      "[notes.jihuanshe.com](<http://notes.jihuanshe.com>)",
    ),
    "normalized",
  )
  // An explicit link next to a bare domain that Linear linked.
  assertEquals(
    compareMarkdown(
      "[notes.jihuanshe.com](http://notes.jihuanshe.com) 和 docs.jihuanshe.com\n",
      "[notes.jihuanshe.com](<http://notes.jihuanshe.com>) 和 [docs.jihuanshe.com](<http://docs.jihuanshe.com>)",
    ),
    "normalized",
  )
})

Deno.test("compareMarkdown - other link changes stay different", () => {
  // Link text that is not the URL itself is content, not an auto-link.
  assertEquals(
    compareMarkdown(
      "notes.jihuanshe.com",
      "[笔记](<http://notes.jihuanshe.com>)",
    ),
    "different",
  )
  // An explicit link to a host without a dot is not a bare-domain auto-link,
  // so losing it is a real difference.
  assertEquals(
    compareMarkdown("[intranet](http://intranet)", "intranet"),
    "different",
  )
  // An explicit link that reads back bare was lost, not auto-linked.
  assertEquals(
    compareMarkdown(
      "[notes.jihuanshe.com](http://notes.jihuanshe.com)",
      "notes.jihuanshe.com",
    ),
    "different",
  )
  // Only the observed http:// rewrite is accepted.
  assertEquals(
    compareMarkdown(
      "notes.jihuanshe.com",
      "[notes.jihuanshe.com](<https://notes.jihuanshe.com>)",
    ),
    "different",
  )
  assertEquals(
    compareMarkdown(
      "notes.jihuanshe.com",
      "[notes.jihuanshe.com](<http://other.jihuanshe.com>)",
    ),
    "different",
  )
})

Deno.test("compareMarkdown - changed content stays different", () => {
  assertEquals(compareMarkdown("- a\n- b\n", "* a\n* c"), "different")
  assertEquals(
    compareMarkdown("见 notes.jihuanshe.com", "见 docs.jihuanshe.com"),
    "different",
  )
  assertEquals(compareMarkdown("Before", "After"), "different")
})
