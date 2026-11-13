import { AuthError } from "./errors.ts"
import { CommandExit } from "./process-exit.ts"

// Bound both headers and body consumption; OAuth POSTs are never retried.
const timeoutMs = 10_000

async function oauthRequest(path: "token" | "revoke", body: URLSearchParams) {
  try {
    const response = await fetch(`https://api.linear.app/oauth/${path}`, {
      method: "POST",
      body,
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
    })
    // Do not retain response text or transport errors: either can echo secrets.
    const data: unknown = await response.json()
    if (
      data == null || typeof data !== "object" ||
      Array.isArray(data)
    ) {
      throw new Error()
    }
    if (
      path === "revoke" && [400, 401].includes(response.status) &&
      (data as Record<string, unknown>).error ===
        "Token has already been revoked."
    ) return { success: true }
    if (!response.ok) throw new Error()
    return data as Record<string, unknown>
  } catch {
    throw new AuthError(
      `OAuth ${
        path === "token" ? "token exchange" : "token revocation"
      } failed`,
      {
        suggestion: path === "token"
          ? "Check LINEAR_CLIENT_ID, LINEAR_CLIENT_SECRET and the application's Client credentials setting."
          : "The temporary token may still be active. Rotate the application's client secret in Linear to invalidate its tokens.",
      },
    )
  }
}

/** One command owns one in-memory access token, including while shutting down. */
export class ClientCredentialsSession {
  private token?: string
  private pending?: Promise<string>
  private closing?: Promise<void>
  private signalCode?: number
  private readOnly = false
  private readonly cancellation = new AbortController()
  private listeners: [Deno.Signal, () => void][] = []

  get signal(): AbortSignal {
    return this.cancellation.signal
  }

  authorization(
    clientId: string,
    clientSecret: string,
    scope: string,
  ): Promise<string> {
    if (this.pending) return this.pending
    const signals: Deno.Signal[] = Deno.build.os === "windows"
      ? ["SIGINT"]
      : ["SIGINT", "SIGTERM"]
    for (const signal of signals) {
      const listener = () => {
        this.signalCode ??= signal === "SIGINT" ? 130 : 143
        this.cancellation.abort(new CommandExit(this.signalCode))
        void this.close().then(() => Deno.exit(this.signalCode))
      }
      Deno.addSignalListener(signal, listener)
      this.listeners.push([signal, listener])
    }
    this.pending = (async () => {
      const data = await oauthRequest(
        "token",
        new URLSearchParams({
          grant_type: "client_credentials",
          client_id: clientId,
          client_secret: clientSecret,
          scope,
        }),
      )
      if (typeof data.access_token === "string" && data.access_token !== "") {
        this.token = data.access_token
      }
      if (
        !this.token || !/^[A-Za-z0-9._~+\/-]+=*$/.test(this.token) ||
        data.token_type !== "Bearer"
      ) {
        throw new AuthError("OAuth token response is invalid", {
          suggestion:
            "Check that the Linear application supports client credentials.",
        })
      }
      if (this.signalCode != null) throw new CommandExit(this.signalCode)
      this.readOnly = (typeof data.scope === "string" ? data.scope : scope)
        .trim() === "read"
      return `Bearer ${this.token}`
    })()
    return this.pending
  }

  reportWriteFailure(): void {
    console.error(
      `Current identity: ${
        this.readOnly ? "read-only app" : "app"
      } from LINEAR_CLIENT_ID. To write, set LINEAR_API_KEY or run \`linear auth login\`.`,
    )
  }

  close(): Promise<void> {
    return this.closing ??= (async () => {
      try {
        // A signal may arrive while the server is still issuing the token.
        await this.pending?.catch(() => {})
        if (this.token) {
          const data = await oauthRequest(
            "revoke",
            new URLSearchParams({
              token: this.token,
              token_type_hint: "access_token",
            }),
          )
          if (data.success !== true) throw new Error()
        }
      } catch {
        // Keep the command's result/effect intact, but fail the process and put
        // a secret-free cleanup diagnostic on stderr (also for JSON commands).
        console.error(
          "OAuth token revocation failed; the temporary token may still be active. Rotate the application's client secret in Linear to invalidate its tokens.",
        )
        if (Deno.exitCode === 0) Deno.exitCode = 1
      } finally {
        this.token = undefined
        this.pending = undefined
        for (const [signal, listener] of this.listeners) {
          Deno.removeSignalListener(signal, listener)
        }
        this.listeners = []
      }
    })()
  }
}
