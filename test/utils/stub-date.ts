import { stub } from "@std/testing/mock"

/** Freeze Date construction and Date.now without replacing HTTP timers. */
export function stubDate(iso: string) {
  const OriginalDate = Date
  const now = OriginalDate.parse(iso)
  const date = stub(globalThis, "Date", function (...args: unknown[]) {
    return Reflect.construct(OriginalDate, args.length ? args : [now])
  } as DateConstructor)
  Object.assign(date, {
    now: () => now,
    parse: OriginalDate.parse,
    UTC: OriginalDate.UTC,
    prototype: OriginalDate.prototype,
  })
  return date
}
