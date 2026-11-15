// A small Solana JSON-RPC client that waits out rate limits: public RPCs answer bursts of
// getBlock with HTTP 429.

const TIMEOUT_MS = 30_000;
const ATTEMPTS = 6;
const MAX_WAIT_MS = 15_000;

export class RpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(`${message} (${code})`);
    this.code = code;
  }
}

export class Rpc {
  readonly url: string;
  constructor(url: string) {
    this.url = url;
  }

  async call<T>(method: string, params: unknown[]): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      const response = await fetch(this.url, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": "sol-fee-oracle" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const retry = response.status === 429 || response.status >= 500;
      if (retry && attempt < ATTEMPTS) {
        const seconds = Number(response.headers.get("retry-after"));
        await new Promise((done) => setTimeout(done, Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, MAX_WAIT_MS) : 1000 * attempt));
        continue;
      }
      if (!response.ok) throw new Error(`${method}: HTTP ${response.status}${response.status === 429 ? ", rate limited; a private RPC URL helps" : ""}`);
      const body = (await response.json()) as { result?: T; error?: { code: number; message: string } };
      if (body.error) throw new RpcError(body.error.code, `${method}: ${body.error.message}`);
      return body.result as T;
    }
  }
}
