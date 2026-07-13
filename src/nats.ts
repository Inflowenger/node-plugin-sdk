// NATS connection from base64-encoded decorated credentials.
// Mirrors nats/natsBox.go.
import {
  connect,
  credsAuthenticator,
  type NatsConnection,
  type ConnectionOptions,
} from "nats";

const NATS_DEFAULT_INBOX = "_INBOX";

export class NatsBox {
  /** decoded .creds text (JWT + NKey seed) */
  private cred: string;
  private url: string;
  private inbox: string = NATS_DEFAULT_INBOX;
  con!: NatsConnection;

  private constructor(credB64: string, url: string) {
    this.cred = credB64;
    this.url = url;
  }

  /** Decode credentials, honor an optional custom inbox prefix, and connect. */
  static async create(credB64: string, url: string): Promise<NatsBox> {
    const n = new NatsBox(credB64, url);
    n.extractToken();
    await n.connect();
    return n;
  }

  private extractToken(): void {
    // INFRA_CRED is the decorated .creds file, base64-encoded.
    this.cred = Buffer.from(this.cred, "base64").toString("utf8");

    // Access-hardening (internal): when many plugins share one account, the
    // user JWT may carry a custom inbox prefix tag scoping its private reply
    // inboxes. Best-effort; falls back to the default inbox otherwise.
    try {
      const inbox = customInboxFromCreds(this.cred);
      if (inbox) this.inbox = inbox;
    } catch {
      /* optional */
    }
  }

  private async connect(): Promise<void> {
    const opts: ConnectionOptions = {
      servers: this.url,
      authenticator: credsAuthenticator(new TextEncoder().encode(this.cred)),
      reconnect: true,
      maxReconnectAttempts: -1,
      pingInterval: 30_000,
      inboxPrefix: this.inbox,
    };
    this.con = await connect(opts);

    // Log lifecycle transitions, like the Go reconnect/disconnect handlers.
    void (async () => {
      for await (const s of this.con.status()) {
        switch (s.type) {
          case "reconnect":
            console.log(`Reconnected to NATS server: ${s.data}`);
            break;
          case "disconnect":
            console.log(`Disconnected from NATS server: ${s.data}`);
            break;
          case "error":
            console.log(`NATS error: ${s.data}`);
            break;
        }
      }
    })();
  }

  /** The live connection, reconnecting if it was closed. */
  get connection(): NatsConnection {
    return this.con;
  }
}

/** Pull a `_INBOX*` tag out of the user JWT inside a decorated .creds blob. */
function customInboxFromCreds(creds: string): string | undefined {
  const m = creds.match(
    /-----BEGIN NATS USER JWT-----\s*([\s\S]*?)\s*-----END NATS USER JWT-----/,
  );
  if (!m) return undefined;
  const jwt = m[1].trim();
  const parts = jwt.split(".");
  if (parts.length < 2) return undefined;
  const payload = JSON.parse(
    Buffer.from(parts[1], "base64url").toString("utf8"),
  );
  const tags: string[] = payload?.nats?.tags ?? [];
  return tags.find((t) => t.startsWith(NATS_DEFAULT_INBOX));
}
