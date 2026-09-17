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

// TODO: Remove this reader and its option injection once Cliffy decodes UTF-8
// across reads and the split-input/PTY regression tests pass without it.
// Cliffy 1.2.1 parses each 8-byte read independently:
// https://github.com/c4spar/cliffy/blob/v1.2.1/prompt/_generic_prompt.ts#L359-L388
function withUtf8Reader<
  T extends { message: string; reader?: InputOptions["reader"] },
>(options: T) {
  const source = options.reader ?? Deno.stdin
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
  const encoder = new TextEncoder()
  let pendingBytes = 0
  return {
    ...options,
    reader: {
      isTerminal: () => source.isTerminal(),
      setRaw: (mode: boolean, rawOptions?: Deno.SetRawOptions) =>
        source.setRaw(mode, rawOptions),
      async read(buffer: Uint8Array): Promise<number> {
        try {
          while (true) {
            // Reserve room for the partial character retained by the decoder.
            const input = buffer.subarray(pendingBytes)
            const count = await source.read(input)
            if (count === null) {
              throw new ValidationError(
                "Interactive input ended before submission",
              )
            }
            let text: string
            try {
              text = decoder.decode(input.subarray(0, count), { stream: true })
            } catch {
              throw new ValidationError("Interactive input is not valid UTF-8")
            }
            const complete = encoder.encode(text)
            pendingBytes += count - complete.length
            if (complete.length > 0) {
              buffer.set(complete)
              return complete.length
            }
          }
        } catch (error) {
          // Cliffy restores raw mode after a successful read only.
          if (source.isTerminal()) source.setRaw(false)
          throw error
        }
      },
    },
  }
}

export class Confirm extends CliffyConfirm {
  static override prompt(options: string | ConfirmOptions) {
    assertPromptAllowed()
    return CliffyConfirm.prompt(
      withUtf8Reader(
        typeof options === "string" ? { message: options } : options,
      ),
    )
  }
}

export class Input extends CliffyInput {
  static override prompt(options: string | InputOptions) {
    assertPromptAllowed()
    return CliffyInput.prompt(
      withUtf8Reader(
        typeof options === "string" ? { message: options } : options,
      ),
    )
  }
}

export class Secret extends CliffySecret {
  static override prompt(options: string | SecretOptions) {
    assertPromptAllowed()
    return CliffySecret.prompt(
      withUtf8Reader(
        typeof options === "string" ? { message: options } : options,
      ),
    )
  }
}

export class Select<T> extends CliffySelect<T> {
  static override prompt<TValue>(options: SelectOptions<TValue>) {
    assertPromptAllowed()
    return CliffySelect.prompt(withUtf8Reader(options))
  }
}

export class Checkbox<T> extends CliffyCheckbox<T> {
  static override prompt<TValue>(options: CheckboxOptions<TValue>) {
    assertPromptAllowed()
    return CliffyCheckbox.prompt(withUtf8Reader(options))
  }
}

export const prompt = ((...args: Parameters<typeof cliffyPrompt>) => {
  assertPromptAllowed()
  return cliffyPrompt(...args)
}) as typeof cliffyPrompt
