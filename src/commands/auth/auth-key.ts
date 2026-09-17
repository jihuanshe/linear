import { Command } from "@cliffy/command"
import { AuthError, handleError } from "../../utils/errors.ts"
import { getResolvedApiKey } from "../../utils/graphql.ts"

export const keyCommand = new Command()
  .name("key")
  .description("Print the resolved API key")
  .action(async () => {
    try {
      const apiKey = await getResolvedApiKey()
      if (apiKey) {
        console.log(apiKey)
      } else {
        throw new AuthError("No API key configured", {
          suggestion: "Set LINEAR_API_KEY or run `linear auth login`.",
        })
      }
    } catch (error) {
      handleError(error, "Failed to get API key")
    }
  })
