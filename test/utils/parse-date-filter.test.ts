import { assertEquals, assertThrows } from "@std/assert"
import { parseDateFilter } from "../../src/utils/linear.ts"
import { ValidationError } from "../../src/utils/errors.ts"

for (
  const [input, expected] of [
    ["2024-01-15", "2024-01-15T00:00:00.000Z"],
    ["2024-01-15T09:00:00Z", "2024-01-15T09:00:00.000Z"],
    ["2024-01-15T09:00:00+05:30", "2024-01-15T03:30:00.000Z"],
  ]
) {
  Deno.test(`parseDateFilter accepts ${input}`, () => {
    assertEquals(parseDateFilter(input, "--created-after"), expected)
  })
}

for (
  const [input, flag] of [
    ["1", "--created-after"],
    ["March 2024", "--updated-after"],
    ["Jan 1", "--created-after"],
  ]
) {
  Deno.test(`parseDateFilter rejects permissive date string ${input}`, () => {
    assertThrows(
      () => parseDateFilter(input, flag),
      ValidationError,
      `Invalid date format for ${flag}: "${input}"`,
    )
  })
}
