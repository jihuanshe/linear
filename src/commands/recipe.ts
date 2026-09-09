import { Command } from "@cliffy/command"
import { findRecipe, listRecipes } from "../recipes/catalog.ts"
import { handleError, NotFoundError, ValidationError } from "../utils/errors.ts"
import { withUsageMetadata } from "./usage.ts"

export const recipeCommand = withUsageMetadata(new Command(), {
  outputModes: ["human", "json"],
})
  .description("Read bundled workflow examples and script source")
  .arguments("[name:string]")
  .option(
    "--json",
    "List recipes as JSON; with a name, include instructions and source",
  )
  .option(
    "--source",
    "Output only the selected script source; redirect to save it",
  )
  .action(async ({ json, source }, name?: string) => {
    try {
      if (source && (name == null || json)) {
        throw new ValidationError(
          "--source requires a recipe name and cannot be combined with --json",
        )
      }
      if (name == null) {
        const index = listRecipes()
        if (json) console.log(JSON.stringify(index, null, 2))
        else {
          const width = Math.max(...index.map((recipe) => recipe.name.length))
          console.log([
            "内嵌 Recipe（可修改的工作流示例）：",
            ...index.map((recipe) =>
              `  ${recipe.name.padEnd(width + 2)}${recipe.description}`
            ),
            "",
            "说明：linear recipe <name>",
            "说明与源码：linear recipe <name> --json",
            "脚本原文：linear recipe <name> --source",
            "读取不会执行脚本。",
          ].join("\n"))
        }
        return
      }
      const recipe = findRecipe(name)
      if (recipe == null) {
        throw new NotFoundError("Recipe", name, {
          suggestion: "Run `linear recipe` to list available examples.",
        })
      }
      if (source) {
        const writer = Deno.stdout.writable.getWriter()
        try {
          await writer.write(new TextEncoder().encode(recipe.source))
        } finally {
          writer.releaseLock()
        }
      } else if (json) console.log(JSON.stringify(recipe, null, 2))
      else console.log(recipe.body.trimEnd())
    } catch (error) {
      handleError(error, "Failed to read recipe")
    }
  })
