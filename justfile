dev *args:
    deno run -A src/main.ts {{ args }}

claude-remove-local:
  -claude plugin remove linear-cli@linear-cli
  -claude plugin marketplace remove linear-cli

claude-install-local:
  claude plugin marketplace add ./
  claude plugin install linear-cli@linear-cli

claude-install-github:
  claude plugin marketplace add jihuanshe/linear
  claude plugin install linear-cli@linear-cli
