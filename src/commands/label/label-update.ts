import { Command, EnumType } from "@cliffy/command"
import { getCliWorkspace } from "../../config.ts"
import { gql } from "../../__codegen__/gql.ts"
import type { IssueLabelUpdateInput } from "../../__codegen__/graphql.ts"
import { getGraphQLClient } from "../../utils/graphql.ts"
import {
  assertMutationReceipt,
  assertMutationSuccess,
  handleError,
  ValidationError,
  WriteError,
} from "../../utils/errors.ts"
import {
  loadBasisFile,
  prepareReplacement,
  referenceField,
  scalarField,
  validateReplacementOptions,
} from "../../utils/replacement.ts"
import { printWriteResult } from "../../utils/write-result.ts"
import { withUsageMetadata } from "../usage.ts"
import { readIssueLabel, readLabelGroup } from "./label-read.ts"

const UpdateIssueLabel = gql(`
  mutation UpdateIssueLabel($id: String!, $input: IssueLabelUpdateInput!) {
    issueLabelUpdate(id: $id, input: $input) {
      success
      issueLabel { ...IssueLabelDetails }
    }
  }
`)

export const updateCommand = withUsageMetadata(new Command(), { writes: true })
  .name("update")
  .description(
    "Update an issue label's group membership or a label group's selection mode by UUID",
  )
  .arguments("<label:string>")
  .type("groupType", new EnumType(["singleSelect", "multiSelect"] as const))
  .option(
    "--group-type <type:groupType>",
    "Selection mode of an existing group",
  )
  .option("--parent <uuid:string>", "Move a label into this group UUID", {
    preserveEmpty: true,
  })
  .option("--clear-parent", "Remove a label from its group")
  .option(
    "--json",
    "Output a JSON write result; the updated label is in data.issueLabel",
  )
  .option(
    "--base-file <path:string>",
    "Saved label view --json output from before editing",
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
  .action(async (options, id) => {
    try {
      if (options.parent != null && options.clearParent) {
        throw new ValidationError(
          "Use either --parent or --clear-parent, not both",
        )
      }
      if (
        options.groupType == null && options.parent == null &&
        !options.clearParent
      ) {
        throw new ValidationError(
          "Provide --group-type, --parent, or --clear-parent",
        )
      }
      const original = options.baseFile == null
        ? undefined
        : await loadBasisFile(options.baseFile)
      validateReplacementOptions({
        original,
        unprotected: options.unprotected,
        expectFields: options.expectField,
        readCommand: {
          command: ["label"],
          target: id,
          workspace: getCliWorkspace(),
        },
      })
      const client = getGraphQLClient()
      const input: IssueLabelUpdateInput = {}
      if (options.groupType != null) input.groupType = options.groupType
      if (options.parent != null) {
        input.parentId = (await readLabelGroup(client, options.parent)).id
      }
      if (options.clearParent) input.parentId = null
      const current = await readIssueLabel(client, id)
      const label = current.issueLabel
      if (options.groupType != null && !label.isGroup) {
        throw new ValidationError(
          "--group-type requires an existing label group",
        )
      }
      if (input.parentId != null && label.isGroup) {
        throw new ValidationError("A label group cannot have a parent group")
      }
      const fields = {
        groupType: scalarField("groupType"),
        parentId: referenceField("parent"),
        isGroup: scalarField("isGroup"),
        teamId: referenceField("team"),
      }
      const plan = prepareReplacement({
        objectKey: "issueLabel",
        targetId: label.id,
        original,
        current,
        desired: input,
        fields,
        unprotected: options.unprotected,
        expectFields: options.expectField,
      })
      if (!Object.keys(plan.input).length) {
        if (options.json) {
          printWriteResult({ issueLabel: label }, {
            effect: "none",
            fields: plan.fields,
          })
        } else console.log("No changes needed")
        return
      }
      const result = await client.request(UpdateIssueLabel, {
        id: label.id,
        input: plan.input,
      })
      assertMutationSuccess(result.issueLabelUpdate, result)
      const updated = result.issueLabelUpdate.issueLabel
      assertMutationReceipt(updated, result, label.id)
      for (const field of plan.fields) {
        const observed = field.inputField === "parentId"
          ? updated.parent === null ? null : updated.parent?.id?.toLowerCase()
          : updated.groupType === null && updated.isGroup
          ? "singleSelect"
          : updated.groupType
        if (observed !== field.desired) {
          throw new WriteError(
            "Label update succeeded but the receipt did not match the requested fields",
            {
              effect: "applied",
              data: { issueLabel: updated },
              details: { fields: plan.fields },
              suggestion:
                "Read the label before continuing; do not repeat the mutation.",
            },
          )
        }
      }
      if (options.json) {
        printWriteResult({ issueLabel: updated }, { fields: plan.fields })
      } else console.log(`✓ Updated label: ${updated.name}`)
    } catch (error) {
      handleError(error, "Failed to update label")
    }
  })
