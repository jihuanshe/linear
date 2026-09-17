import { Command } from "@cliffy/command"
import { withUsageMetadata } from "../usage.ts"
import { Input, Select } from "../../utils/prompt.ts"
import { openEditor } from "../../utils/editor.ts"
import { readTextSource } from "../../utils/text-source.ts"
import { gql } from "../../__codegen__/gql.ts"
import type { InitiativeUpdateInput } from "../../__codegen__/graphql.ts"
import {
  INITIATIVE_STATUSES,
  parseInitiativeStatus,
} from "./initiative-status.ts"
import { getGraphQLClient } from "../../utils/graphql.ts"
import { lookupUserId } from "../../utils/linear.ts"
import {
  assertMutationReceipt,
  assertMutationSuccess,
  handleError,
  NotFoundError,
  ValidationError,
} from "../../utils/errors.ts"
import {
  loadBasisFile,
  prepareReplacement,
  referenceField,
  scalarField,
  validateReplacementOptions,
} from "../../utils/replacement.ts"
import { readInitiative } from "./initiative-read.ts"
import { resolveInitiativeId } from "./initiative-resolve.ts"
import { printWriteResult } from "../../utils/write-result.ts"

const UpdateInitiative = gql(`
  mutation UpdateInitiative($id: String!, $input: InitiativeUpdateInput!) {
    initiativeUpdate(id: $id, input: $input) {
      success
      initiative {
        id slugId name description status targetDate color icon url
        owner { id displayName }
      }
    }
  }
`)

const UpdateInitiativeWithContent = gql(`
  mutation UpdateInitiativeWithContent($id: String!, $input: InitiativeUpdateInput!) {
    initiativeUpdate(id: $id, input: $input) {
      success
      initiative {
        id slugId name description content status targetDate color icon url
        owner { id displayName }
      }
    }
  }
`)

const fields = {
  name: scalarField("name"),
  description: scalarField("description"),
  content: scalarField("content"),
  status: scalarField("status"),
  targetDate: scalarField("targetDate"),
  color: scalarField("color"),
  icon: scalarField("icon"),
  ownerId: referenceField("owner"),
}

export const updateCommand = withUsageMetadata(new Command(), {
  writes: true,
  interactive: true,
})
  .name("update")
  .description(
    "Update a Linear initiative by UUID, slug ID, or name using its original read basis",
  )
  .arguments("<initiative:string>")
  .option("-n, --name <name:string>", "New name for the initiative", {
    preserveEmpty: true,
  })
  .option(
    "-d, --description <description:string>",
    "New description; empty string clears it",
    { preserveEmpty: true },
  )
  .option(
    "--content <content:string>",
    "Replace the initiative's Markdown content; empty string clears it",
    { preserveEmpty: true },
  )
  .option(
    "--content-file <path:string>",
    "Read UTF-8 content from a file (- for stdin); replaces the full content",
    { preserveEmpty: true },
  )
  .option("--edit", "Open the current initiative content in an editor")
  .option(
    "--status <status:string>",
    "New status (planned, active, completed, proposed, canceled; case-insensitive)",
    { preserveEmpty: true },
  )
  .option(
    "--owner <owner:string>",
    "New owner (user UUID, username, name, email, 'self', or '@me')",
    { preserveEmpty: true },
  )
  .option(
    "--target-date <date:string>",
    "Target completion date (YYYY-MM-DD)",
    { preserveEmpty: true },
  )
  .option("--color <color:string>", "Initiative color (hex, e.g., #5E6AD2)", {
    preserveEmpty: true,
  })
  .option("--icon <icon:string>", "Initiative icon name", {
    preserveEmpty: true,
  })
  .option("-i, --interactive", "Interactive mode for updates")
  .option("-j, --json", "Output the write result as JSON; never prompt")
  .option(
    "--base-file <path:string>",
    "Saved view --json output from before editing; compare original values before writing",
    { preserveEmpty: true },
  )
  .option(
    "--unprotected",
    "Skip original-value comparison; domain checks still apply",
  )
  .option(
    "--expect-field <field:string>",
    "Require this API field to match the saved original value (repeatable)",
    { collect: true, preserveEmpty: true },
  )
  .action(async (options, initiativeReference) => {
    try {
      let content = await readTextSource(
        "content",
        options.content,
        options.contentFile,
      )
      if (
        options.edit && (content != null || options.json || options.interactive)
      ) {
        throw new ValidationError(
          "--edit cannot be combined with --content, --content-file, --json, or --interactive",
        )
      }
      for (
        const [field, value] of Object.entries({
          name: options.name,
          status: options.status,
          owner: options.owner,
          "target-date": options.targetDate,
        })
      ) {
        if (value != null && value.trim() === "") {
          throw new ValidationError(`--${field} cannot be empty`)
        }
      }
      if (options.interactive && options.json) {
        throw new ValidationError(
          "JSON mode cannot prompt; provide update fields explicitly",
        )
      }
      if (
        options.interactive &&
        (!Deno.stdin.isTerminal() || !Deno.stdout.isTerminal())
      ) {
        throw new ValidationError("Interactive updates require a terminal")
      }
      const input: InitiativeUpdateInput = {}
      if (options.name !== undefined) input.name = options.name
      if (options.description !== undefined) {
        input.description = options.description
      }
      if (content !== undefined) input.content = content
      if (options.status !== undefined) {
        input.status = parseInitiativeStatus(options.status)
      }
      if (options.targetDate !== undefined) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(options.targetDate)) {
          throw new ValidationError("Target date must be in YYYY-MM-DD format")
        }
        input.targetDate = options.targetDate
      }
      if (options.color !== undefined) input.color = options.color
      if (options.icon !== undefined) input.icon = options.icon
      let original = options.baseFile != null
        ? await loadBasisFile(options.baseFile)
        : undefined
      const interactive = options.interactive && !options.json &&
        Deno.stdin.isTerminal() && Object.keys(input).length === 0 &&
        options.owner === undefined
      if (
        !interactive && !options.edit && Object.keys(input).length === 0 &&
        options.owner === undefined
      ) {
        if (
          options.baseFile != null || options.unprotected ||
          options.expectField != null
        ) {
          validateReplacementOptions({
            original,
            unprotected: options.unprotected,
            expectFields: options.expectField,
          })
        }
        if (options.expectField?.length) {
          throw new ValidationError(
            "--expect-field requires at least one update option",
          )
        }
        if (options.json) printWriteResult(null, { effect: "none", fields: [] })
        else console.log("No changes specified")
        return
      }
      if (
        (!interactive && !options.edit) || original != null ||
        options.unprotected
      ) {
        validateReplacementOptions({
          original,
          unprotected: options.unprotected,
          expectFields: options.expectField,
        })
      }
      const client = getGraphQLClient()
      const resolvedId = await resolveInitiativeId(client, initiativeReference)
      if (options.edit) {
        const initial = await readInitiative(client, resolvedId, {
          includeContent: true,
        })
        if (!options.unprotected) original ??= initial
        content = await openEditor(initial.initiative!.content ?? "")
        input.content = content
      }
      if (options.owner !== undefined) {
        const ownerId = await lookupUserId(options.owner)
        if (!ownerId) throw new NotFoundError("Owner", options.owner)
        input.ownerId = ownerId
      }

      if (
        interactive
      ) {
        const initial = await readInitiative(client, resolvedId, {
          includeContent: true,
        })
        if (!options.unprotected) original ??= initial
        const initiative = initial.initiative!
        console.log(`\nUpdating initiative: ${initiative.name}\n`)
        const name = await Input.prompt({
          message: "Name:",
          default: initiative.name,
        })
        if (name !== initiative.name) input.name = name
        const description = await Input.prompt({
          message: "Description:",
          default: initiative.description || "",
        })
        if (description !== (initiative.description || "")) {
          input.description = description
        }
        const status = await Select.prompt({
          message: "Status:",
          options: INITIATIVE_STATUSES,
          default: INITIATIVE_STATUSES.find((value) =>
            value.value.toLowerCase() === initiative.status.toLowerCase()
          )?.value,
        })
        if (status !== initiative.status) {
          input.status = parseInitiativeStatus(status)
        }
        const targetDate = await Input.prompt({
          message: "Target date (YYYY-MM-DD):",
          default: initiative.targetDate || "",
        })
        if (targetDate !== (initiative.targetDate || "")) {
          if (targetDate && !/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
            throw new ValidationError(
              "Target date must be in YYYY-MM-DD format",
            )
          }
          input.targetDate = targetDate || null
        }
        const color = await Input.prompt({
          message: "Color (hex, e.g., #5E6AD2):",
          default: initiative.color || "",
        })
        if (color !== (initiative.color || "")) input.color = color || null
      }

      if (Object.keys(input).length === 0) {
        if (options.expectField?.length) {
          throw new ValidationError(
            "--expect-field requires at least one update option",
          )
        }
        if (options.json) printWriteResult(null, { effect: "none", fields: [] })
        else console.log("No changes specified")
        return
      }
      const current = await readInitiative(client, resolvedId, {
        includeContent: content !== undefined ||
          options.expectField?.includes("content"),
      })
      const plan = prepareReplacement({
        objectKey: "initiative",
        targetId: resolvedId,
        original,
        current,
        desired: input,
        fields,
        unprotected: options.unprotected,
        expectFields: options.expectField,
      })
      if (Object.keys(plan.input).length === 0) {
        if (options.json) {
          printWriteResult({ initiative: current.initiative }, {
            effect: "none",
            fields: plan.fields,
          })
        } else console.log("No changes needed")
        return
      }
      const result = content !== undefined
        ? await client.request(UpdateInitiativeWithContent, {
          id: resolvedId,
          input: plan.input,
        })
        : await client.request(UpdateInitiative, {
          id: resolvedId,
          input: plan.input,
        })
      assertMutationSuccess(result.initiativeUpdate, result)
      const updated = result.initiativeUpdate.initiative
      assertMutationReceipt(updated, result, resolvedId)
      if (options.json) {
        printWriteResult({ initiative: updated }, { fields: plan.fields })
      } else {
        console.log(`✓ Updated initiative: ${updated.name}`)
        if (updated.url) console.log(updated.url)
      }
    } catch (error) {
      handleError(error, "Failed to update initiative")
    }
  })
