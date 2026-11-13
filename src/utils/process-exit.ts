import { AsyncLocalStorage } from "node:async_hooks"

const deferredExit = new AsyncLocalStorage<boolean>()

/** Unwind the command so invocation cleanup can finish before process exit. */
export class CommandExit extends Error {
  constructor(readonly code: number) {
    super(`Command exited with status ${code}`)
  }
}

export function withDeferredExit<T>(action: () => Promise<T>): Promise<T> {
  return deferredExit.run(true, action)
}

export function exit(code: number): never {
  if (deferredExit.getStore()) throw new CommandExit(code)
  Deno.exit(code)
}
