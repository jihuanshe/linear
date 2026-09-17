import { assertEquals, assertThrows } from "@std/assert"
import { resolveMakePublic } from "../../src/utils/upload.ts"
import { formatAsMarkdownLink } from "../../src/operations/issue-content.ts"
import { ValidationError } from "../../src/utils/errors.ts"

Deno.test("generated file links escape labels and destinations without changing asset identity", () => {
  assertEquals(
    formatAsMarkdownLink({
      filename: "evidence]draft.txt",
      assetUrl: "https://uploads.linear.app/file",
      contentType: "text/plain",
    }),
    "[evidence\\]draft.txt](https://uploads.linear.app/file)",
  )
  assertEquals(
    formatAsMarkdownLink({
      filename: "[a]*_`<&\\\r\n.png",
      assetUrl: "https://public.linear.app/a (b).png?x=1&copy;=2",
      contentType: "image/png",
    }),
    "![\\[a\\]\\*\\_\\`\\<\\&\\\\&#13;&#10;.png](https://public.linear.app/a%20%28b%29.png?x=1&amp;copy;=2)",
  )
})

Deno.test("resolveMakePublic - defaults to private when not requested", () => {
  assertEquals(resolveMakePublic("image/png"), false)
  assertEquals(resolveMakePublic("image/png", undefined), false)
})

Deno.test("resolveMakePublic - defaults to private for non-image types", () => {
  assertEquals(resolveMakePublic("application/pdf"), false)
})

Deno.test("resolveMakePublic - allows public for raster images when requested", () => {
  for (
    const type of [
      "image/png",
      "image/jpeg",
      "image/gif",
      "image/webp",
      "image/bmp",
      "image/tiff",
    ]
  ) {
    assertEquals(resolveMakePublic(type, true), true)
  }
})

Deno.test("resolveMakePublic - explicit false stays private even for images", () => {
  assertEquals(resolveMakePublic("image/png", false), false)
})

Deno.test("resolveMakePublic - rejects public for non-public-capable types", () => {
  // SVG is an image but not allowed to be public by Linear
  assertThrows(
    () => resolveMakePublic("image/svg+xml", true),
    ValidationError,
  )
  assertThrows(
    () => resolveMakePublic("application/pdf", true),
    ValidationError,
  )
  assertThrows(
    () => resolveMakePublic("application/octet-stream", true),
    ValidationError,
  )
})
