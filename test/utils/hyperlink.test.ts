import { assertEquals } from "@std/assert"
import {
  formatPathHyperlink,
  hyperlink,
  resolveHyperlinkFormat,
  shouldEnableHyperlinks,
  shouldShowSpinner,
} from "../../src/utils/hyperlink.ts"

Deno.test("hyperlinks preserve remote URLs and encode local path characters", () => {
  assertEquals(
    hyperlink("click me", "https://example.com"),
    "\x1b]8;;https://example.com\x1b\\click me\x1b]8;;\x1b\\",
  )
  assertEquals(
    hyperlink("", "https://example.com"),
    "\x1b]8;;https://example.com\x1b\\\x1b]8;;\x1b\\",
  )
  assertEquals(resolveHyperlinkFormat("default"), "file://{host}{path}")
  assertEquals(resolveHyperlinkFormat("custom://{path}"), "custom://{path}")
  assertEquals(
    formatPathHyperlink("image", "https://example.com/img.png", "default"),
    "\x1b]8;;https://example.com/img.png\x1b\\image\x1b]8;;\x1b\\",
  )
  const local = formatPathHyperlink(
    "image",
    "/tmp/test/my image#1.png",
    "custom://{path}",
  )
  assertEquals(
    local,
    "\x1b]8;;custom:///tmp/test/my%20image%231.png\x1b\\image\x1b]8;;\x1b\\",
  )
})

// Tests for shouldShowSpinner

Deno.test({
  name: "shouldShowSpinner - returns false when NO_COLOR is set",
  fn() {
    // Mock stdout.isTerminal to return true
    const originalIsTerminal = Deno.stdout.isTerminal
    Deno.stdout.isTerminal = () => true

    // Set NO_COLOR
    const originalNoColor = Deno.env.get("NO_COLOR")
    Deno.env.set("NO_COLOR", "1")

    try {
      assertEquals(shouldShowSpinner(), false)
    } finally {
      Deno.stdout.isTerminal = originalIsTerminal
      if (originalNoColor != null) {
        Deno.env.set("NO_COLOR", originalNoColor)
      } else {
        Deno.env.delete("NO_COLOR")
      }
    }
  },
})

Deno.test({
  name: "shouldShowSpinner - returns false when stdout is not a terminal",
  fn() {
    // Mock stdout.isTerminal to return false
    const originalIsTerminal = Deno.stdout.isTerminal
    Deno.stdout.isTerminal = () => false

    // Ensure NO_COLOR is not set
    const originalNoColor = Deno.env.get("NO_COLOR")
    const originalTerm = Deno.env.get("TERM")
    const originalCliColor = Deno.env.get("CLICOLOR")
    if (originalNoColor != null) {
      Deno.env.delete("NO_COLOR")
    }
    Deno.env.set("TERM", "xterm-256color")
    Deno.env.delete("CLICOLOR")

    try {
      assertEquals(shouldShowSpinner(), false)
    } finally {
      Deno.stdout.isTerminal = originalIsTerminal
      if (originalNoColor != null) {
        Deno.env.set("NO_COLOR", originalNoColor)
      }
      if (originalTerm != null) Deno.env.set("TERM", originalTerm)
      else Deno.env.delete("TERM")
      if (originalCliColor != null) Deno.env.set("CLICOLOR", originalCliColor)
      else Deno.env.delete("CLICOLOR")
    }
  },
})

Deno.test({
  name: "shouldShowSpinner - returns true when terminal and NO_COLOR not set",
  fn() {
    // Mock stdout.isTerminal to return true
    const originalIsTerminal = Deno.stdout.isTerminal
    Deno.stdout.isTerminal = () => true

    // Ensure NO_COLOR is not set
    const originalNoColor = Deno.env.get("NO_COLOR")
    const originalTerm = Deno.env.get("TERM")
    const originalCliColor = Deno.env.get("CLICOLOR")
    if (originalNoColor != null) {
      Deno.env.delete("NO_COLOR")
    }
    Deno.env.set("TERM", "xterm-256color")
    Deno.env.delete("CLICOLOR")

    try {
      assertEquals(shouldShowSpinner(), true)
    } finally {
      Deno.stdout.isTerminal = originalIsTerminal
      if (originalNoColor != null) {
        Deno.env.set("NO_COLOR", originalNoColor)
      }
      if (originalTerm != null) Deno.env.set("TERM", originalTerm)
      else Deno.env.delete("TERM")
      if (originalCliColor != null) Deno.env.set("CLICOLOR", originalCliColor)
      else Deno.env.delete("CLICOLOR")
    }
  },
})

Deno.test({
  name: "shouldShowSpinner - returns false when NO_COLOR is empty string",
  fn() {
    // Mock stdout.isTerminal to return true
    const originalIsTerminal = Deno.stdout.isTerminal
    Deno.stdout.isTerminal = () => true

    // Set NO_COLOR to empty string (still counts as set)
    const originalNoColor = Deno.env.get("NO_COLOR")
    Deno.env.set("NO_COLOR", "")

    try {
      assertEquals(shouldShowSpinner(), false)
    } finally {
      Deno.stdout.isTerminal = originalIsTerminal
      if (originalNoColor != null) {
        Deno.env.set("NO_COLOR", originalNoColor)
      } else {
        Deno.env.delete("NO_COLOR")
      }
    }
  },
})

// Tests for shouldEnableHyperlinks (ensure it has same behavior)

Deno.test({
  name: "shouldEnableHyperlinks - returns false when NO_COLOR is set",
  fn() {
    // Mock stdout.isTerminal to return true
    const originalIsTerminal = Deno.stdout.isTerminal
    Deno.stdout.isTerminal = () => true

    // Set NO_COLOR
    const originalNoColor = Deno.env.get("NO_COLOR")
    Deno.env.set("NO_COLOR", "1")

    try {
      assertEquals(shouldEnableHyperlinks(), false)
    } finally {
      Deno.stdout.isTerminal = originalIsTerminal
      if (originalNoColor != null) {
        Deno.env.set("NO_COLOR", originalNoColor)
      } else {
        Deno.env.delete("NO_COLOR")
      }
    }
  },
})

Deno.test({
  name: "shouldEnableHyperlinks - returns false when stdout is not a terminal",
  fn() {
    // Mock stdout.isTerminal to return false
    const originalIsTerminal = Deno.stdout.isTerminal
    Deno.stdout.isTerminal = () => false

    // Ensure NO_COLOR is not set
    const originalNoColor = Deno.env.get("NO_COLOR")
    if (originalNoColor != null) {
      Deno.env.delete("NO_COLOR")
    }

    try {
      assertEquals(shouldEnableHyperlinks(), false)
    } finally {
      Deno.stdout.isTerminal = originalIsTerminal
      if (originalNoColor != null) {
        Deno.env.set("NO_COLOR", originalNoColor)
      }
    }
  },
})

Deno.test({
  name:
    "shouldEnableHyperlinks - returns true when terminal and NO_COLOR not set",
  fn() {
    // Mock stdout.isTerminal to return true
    const originalIsTerminal = Deno.stdout.isTerminal
    Deno.stdout.isTerminal = () => true

    // Ensure NO_COLOR is not set
    const originalNoColor = Deno.env.get("NO_COLOR")
    const originalTerm = Deno.env.get("TERM")
    const originalCliColor = Deno.env.get("CLICOLOR")
    if (originalNoColor != null) {
      Deno.env.delete("NO_COLOR")
    }
    Deno.env.set("TERM", "xterm-256color")
    Deno.env.delete("CLICOLOR")

    try {
      assertEquals(shouldEnableHyperlinks(), true)
    } finally {
      Deno.stdout.isTerminal = originalIsTerminal
      if (originalNoColor != null) {
        Deno.env.set("NO_COLOR", originalNoColor)
      }
      if (originalTerm != null) Deno.env.set("TERM", originalTerm)
      else Deno.env.delete("TERM")
      if (originalCliColor != null) Deno.env.set("CLICOLOR", originalCliColor)
      else Deno.env.delete("CLICOLOR")
    }
  },
})
