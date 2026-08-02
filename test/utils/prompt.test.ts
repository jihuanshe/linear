import { assertEquals, assertThrows } from "@std/assert"
import { stub } from "@std/testing/mock"
import {
  assertPromptAllowed,
  Confirm,
  isPromptDisabled,
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
