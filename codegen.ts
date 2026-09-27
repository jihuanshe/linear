import type { CodegenConfig } from "@graphql-codegen/cli"

// TODO: Unpin @graphql-codegen/cli from 7.4.1 once a newer release can load
// the "client" preset under Deno without node_modules. Since 7.4.2
// (https://github.com/dotansimha/graphql-code-generator/pull/10956) the ESM
// build resolves presets with createRequire(cwd), which cannot see Deno's npm
// cache, so generation fails with "Unable to find preset matching client".
// Update the import and the generate-graphql-types task in deno.json together,
// then confirm `deno task generate-graphql-types` writes src/__codegen__/.

const config: CodegenConfig = {
  schema: "graphql/schema.graphql",
  documents: ["src/**/*.ts"],
  generates: {
    "src/__codegen__/": {
      preset: "client",
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
