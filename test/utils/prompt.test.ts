import { assertEquals, assertRejects, assertThrows } from "@std/assert"
import { stub } from "@std/testing/mock"
import {
  assertPromptAllowed,
  Confirm,
  Input,
  isPromptDisabled,
  prompt,
  Secret,
  Select,
} from "../../src/utils/prompt.ts"
import { ValidationError } from "../../src/utils/errors.ts"

const ENV_NAME = "LINEAR_PROMPT_DISABLED"

Deno.test("LINEAR_PROMPT_DISABLED accepts the documented boolean values", () => {
  const original = Deno.env.get(ENV_NAME)
  try {
    for (const value of [undefined, "", "0", "false"]) {
      if (value == null) Deno.env.delete(ENV_NAME)
      else Deno.env.set(ENV_NAME, value)
      assertEquals(isPromptDisabled(), false)
    }

    for (const value of ["1", "true"]) {
      Deno.env.set(ENV_NAME, value)
      assertEquals(isPromptDisabled(), true)
    }

    Deno.env.set(ENV_NAME, "yes")
    assertThrows(
      () => isPromptDisabled(),
      ValidationError,
      `${ENV_NAME} must be 0, 1, false, or true`,
    )
  } finally {
    if (original == null) Deno.env.delete(ENV_NAME)
    else Deno.env.set(ENV_NAME, original)
  }
})

Deno.test("Input and Secret preserve multibyte characters across short reads", async () => {
  const terminal = stub(
    Object.getPrototypeOf(Deno.stdin),
    "isTerminal",
    () => true,
  )
  const original = Deno.env.get(ENV_NAME)
  Deno.env.delete(ENV_NAME)
  const text = "é 发布总控🙂与回滚演练 Z"
  try {
    for (const promptType of [Input, Secret]) {
      for (let chunkSize = 1; chunkSize <= 8; chunkSize++) {
        const bytes = new TextEncoder().encode(text + "\r")
        let offset = 0
        const value = await promptType.prompt({
          message: "Title",
          transform: (value) => value,
          writer: { writeSync: (buffer) => buffer.length },
          reader: {
            isTerminal: () => false,
            setRaw: () => {},
            read(buffer) {
              if (offset === bytes.length) {
                throw new Error("Input did not submit")
              }
              const count = Math.min(
                chunkSize,
                buffer.length,
                bytes.length - offset,
              )
              buffer.set(bytes.subarray(offset, offset + count))
              offset += count
              return Promise.resolve(count)
            },
          },
        })
        assertEquals(value, text, `chunk size ${chunkSize}`)
      }
    }
  } finally {
    terminal.restore()
    if (original == null) Deno.env.delete(ENV_NAME)
    else Deno.env.set(ENV_NAME, original)
  }
})

Deno.test("prompt wizard keeps Chinese search and complete editing key sequences", async () => {
  const terminal = stub(
    Object.getPrototypeOf(Deno.stdin),
    "isTerminal",
    () => true,
  )
  const original = Deno.env.get(ENV_NAME)
  Deno.env.delete(ENV_NAME)
  const chunks = ["abc", "\x1b[D", "\x7f", "Z", "\r", "发布", "\r"].map((
    text,
  ) => new TextEncoder().encode(text))
  try {
    const result = await prompt([
      { name: "edited", message: "Title", type: Input },
      {
        name: "team",
        message: "Team",
        type: Select,
        search: true,
        options: [
          { name: "客服", value: "support" },
          { name: "发布", value: "release" },
        ],
      },
    ], {
      writer: { writeSync: (buffer) => buffer.length },
      reader: {
        isTerminal: () => false,
        setRaw: () => {},
        read(buffer) {
          const next = chunks.shift()
          if (!next) throw new Error("Prompt did not submit")
          const count = Math.min(buffer.length, next.length)
          buffer.set(next.subarray(0, count))
          if (count < next.length) chunks.unshift(next.subarray(count))
          return Promise.resolve(count)
        },
      },
    })
    assertEquals(result, { edited: "aZc", team: "release" })
    assertEquals(chunks.length, 0)
  } finally {
    terminal.restore()
    if (original == null) Deno.env.delete(ENV_NAME)
    else Deno.env.set(ENV_NAME, original)
  }
})

Deno.test("Input rejects malformed or truncated UTF-8 and restores raw mode", async () => {
  const terminal = stub(
    Object.getPrototypeOf(Deno.stdin),
    "isTerminal",
    () => true,
  )
  const original = Deno.env.get(ENV_NAME)
  Deno.env.delete(ENV_NAME)
  try {
    for (
      const bytes of [
        new Uint8Array([0xc3, 0x28, 13]),
        new Uint8Array([0xe4, 0xb8]),
      ]
    ) {
      let read = false
      const rawModes: boolean[] = []
      await assertRejects(() =>
        Input.prompt({
          message: "Title",
          writer: { writeSync: (buffer) => buffer.length },
          reader: {
            isTerminal: () => true,
            setRaw: (mode) => {
              rawModes.push(mode)
            },
            read(buffer) {
              if (read) return Promise.resolve(null)
              read = true
              buffer.set(bytes)
              return Promise.resolve(bytes.length)
            },
          },
        }), ValidationError)
      assertEquals(rawModes.at(-1), false)
    }
  } finally {
    terminal.restore()
    if (original == null) Deno.env.delete(ENV_NAME)
    else Deno.env.set(ENV_NAME, original)
  }
})

Deno.test("safe prompt exports reject prompts when disabled", () => {
  const original = Deno.env.get(ENV_NAME)
  Deno.env.set(ENV_NAME, "1")
  try {
    assertThrows(
      () => Confirm.prompt("Continue?"),
      ValidationError,
      `Interactive prompting is disabled by ${ENV_NAME}`,
    )
  } finally {
    if (original == null) Deno.env.delete(ENV_NAME)
    else Deno.env.set(ENV_NAME, original)
  }
})

Deno.test("assertPromptAllowed rejects non-terminal stdin with a suggestion", () => {
  const original = Deno.env.get(ENV_NAME)
  Deno.env.delete(ENV_NAME)
  const terminalStub = stub(
    Object.getPrototypeOf(Deno.stdin),
    "isTerminal",
    () => false,
  )
  try {
    const error = assertThrows(
      () => Confirm.prompt("Continue?"),
      ValidationError,
      "Interactive prompting requires a terminal",
    )
    assertEquals(
      error.suggestion,
      "Provide all required command options explicitly, or unset LINEAR_PROMPT_DISABLED.",
    )

    const customError = assertThrows(
      () => assertPromptAllowed({ suggestion: "Use --force." }),
      ValidationError,
      "Interactive prompting requires a terminal",
    )
    assertEquals(customError.suggestion, "Use --force.")
  } finally {
    terminalStub.restore()
    if (original == null) Deno.env.delete(ENV_NAME)
    else Deno.env.set(ENV_NAME, original)
  }
})
