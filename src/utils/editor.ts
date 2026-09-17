import { CliError, ValidationError } from "./errors.ts"
import { readTextSource } from "./text-source.ts"

export async function getEditor(): Promise<string | null> {
  // Try git config first
  try {
    const process = new Deno.Command("git", {
      args: ["config", "--global", "core.editor"],
    })
    const { stdout, success } = await process.output()
    if (success) {
      const editor = new TextDecoder().decode(stdout).trim()
      if (editor) return editor
    }
  } catch {
    // Fall through to next option
  }

  // Try EDITOR environment variable
  const editor = Deno.env.get("EDITOR")
  if (editor) return editor

  return null
}

export async function openEditor(initialText = ""): Promise<string> {
  const editor = await getEditor()
  if (!editor) {
    throw new ValidationError("No editor found", {
      suggestion:
        "Set EDITOR or configure git editor with: git config --global core.editor <editor>",
    })
  }

  // Create a temporary file
  const tempFile = await Deno.makeTempFile({ suffix: ".md" })

  try {
    await Deno.writeTextFile(tempFile, initialText)
    // Open the editor
    const process = new Deno.Command(editor, {
      args: [tempFile],
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    })

    const { success } = await process.spawn().status

    if (!success) {
      throw new CliError("Editor exited with an error")
    }

    return (await readTextSource("content", undefined, tempFile))!
  } catch (error) {
    if (error instanceof CliError) throw error
    throw new CliError(
      `Failed to open editor: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    )
  } finally {
    // Clean up the temporary file
    try {
      await Deno.remove(tempFile)
    } catch {
      // Ignore cleanup errors
    }
  }
}
