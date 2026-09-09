/**
 * One machine result for dedicated writes. Raw `api` deliberately retains its
 * upstream GraphQL envelope. Execution facts and read-back evidence are
 * separate: an applied mutation cannot become retryable after a failed read.
 */
export type WriteEffect = "none" | "applied" | "unknown"

let machineOutput = false

export function setMachineOutput(value: boolean): void {
  machineOutput = value
}

export function isMachineOutput(): boolean {
  return machineOutput
}

export interface WriteResultOptions {
  effect?: "none" | "applied"
  fields?: unknown
  verification?: unknown
  receipts?: unknown
}

export function writeResult<T>(data: T, options: WriteResultOptions = {}) {
  const { effect = "applied", ...evidence } = options
  return { ok: true as const, effect, data, ...evidence }
}

/** Called only by a command's JSON output branch, never by operation code. */
export function printWriteResult<T>(
  data: T,
  options: WriteResultOptions = {},
): void {
  console.log(JSON.stringify(writeResult(data, options), null, 2))
}
