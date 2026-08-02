import {
  Checkbox as CliffyCheckbox,
  type CheckboxOptions,
  Confirm as CliffyConfirm,
  type ConfirmOptions,
  Input as CliffyInput,
  type InputOptions,
  prompt as cliffyPrompt,
  Secret as CliffySecret,
  type SecretOptions,
  Select as CliffySelect,
  type SelectOptions,
} from "@cliffy/prompt"
import { ValidationError } from "./errors.ts"

const PROMPT_DISABLED_ENV = "LINEAR_PROMPT_DISABLED"
const DEFAULT_PROMPT_SUGGESTION =
  `Provide all required command options explicitly, or unset ${PROMPT_DISABLED_ENV}.`

export function isPromptDisabled(): boolean {
  const value = Deno.env.get(PROMPT_DISABLED_ENV)
  if (value == null || value === "" || value === "0" || value === "false") {
    return false
  }
  if (value === "1" || value === "true") {
    return true
  }
  throw new ValidationError(
    `${PROMPT_DISABLED_ENV} must be 0, 1, false, or true`,
    {
      suggestion:
        `Use ${PROMPT_DISABLED_ENV}=1 to disable prompts, or unset it to allow prompts.`,
    },
  )
}

export function assertPromptEnabled(
  suggestion = DEFAULT_PROMPT_SUGGESTION,
): void {
  if (isPromptDisabled()) {
    throw new ValidationError(
      `Interactive prompting is disabled by ${PROMPT_DISABLED_ENV}`,
      { suggestion },
    )
  }
}

export function assertPromptAllowed(
  options: { suggestion?: string } = {},
): void {
  const suggestion = options.suggestion ?? DEFAULT_PROMPT_SUGGESTION
  assertPromptEnabled(suggestion)
  if (!Deno.stdin.isTerminal()) {
    throw new ValidationError("Interactive prompting requires a terminal", {
      suggestion,
    })
  }
}

export class Confirm extends CliffyConfirm {
  static override prompt(options: string | ConfirmOptions) {
    assertPromptAllowed()
    return CliffyConfirm.prompt(options)
  }
}

export class Input extends CliffyInput {
  static override prompt(options: string | InputOptions) {
    assertPromptAllowed()
    return CliffyInput.prompt(options)
  }
}

export class Secret extends CliffySecret {
  static override prompt(options: string | SecretOptions) {
    assertPromptAllowed()
    return CliffySecret.prompt(options)
  }
}

export class Select<T> extends CliffySelect<T> {
  static override prompt<TValue>(options: SelectOptions<TValue>) {
    assertPromptAllowed()
    return CliffySelect.prompt(options)
  }
}

export class Checkbox<T> extends CliffyCheckbox<T> {
  static override prompt<TValue>(options: CheckboxOptions<TValue>) {
    assertPromptAllowed()
    return CliffyCheckbox.prompt(options)
  }
}

export const prompt = ((...args: Parameters<typeof cliffyPrompt>) => {
  assertPromptAllowed()
  return cliffyPrompt(...args)
}) as typeof cliffyPrompt
