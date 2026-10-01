import type { CodegenConfig } from "@graphql-codegen/cli"
import { preset as clientPreset } from "@graphql-codegen/client-preset"

const config: CodegenConfig = {
  schema: "graphql/schema.graphql",
  documents: ["src/**/*.ts"],
  generates: {
    "src/__codegen__/": {
      preset: clientPreset,
      plugins: [],
      config: {
        enumsAsTypes: true,
        scalars: {
          DateTime: "string",
          DateTimeOrDuration: "string",
          Duration: "string",
          JSON: "unknown",
          JSONObject: "unknown",
          TimelessDate: "string",
          TimelessDateOrDuration: "string",
          UUID: "string",
        },
      },
      presetConfig: {
        gqlTagName: "gql",
        fragmentMasking: false,
      },
    },
  },
}

export default config
