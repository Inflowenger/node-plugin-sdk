// In-memory doubles so the request path can be exercised without a broker.
import type { Msg } from "nats";
import { Plugin } from "../src/index.js";

const decoder = new TextDecoder();

/** A NATS message that records what the SDK replied to it. */
export class MockMsg {
  subject: string;
  data: Uint8Array;
  readonly replies: string[] = [];

  constructor(subject = "inflow.cpu.PID.run", data: Uint8Array = new Uint8Array()) {
    this.subject = subject;
    this.data = data;
  }

  respond(data: Uint8Array): boolean {
    this.replies.push(decoder.decode(data));
    return true;
  }

  /** The reply, parsed — `{jobId}` on accept, `{error}` on reject. */
  reply(): { jobId?: string; error?: string } {
    if (this.replies.length === 0) return {};
    return JSON.parse(this.replies[0]!) as { jobId?: string; error?: string };
  }

  get msg(): Msg {
    return this as unknown as Msg;
  }
}

/** One command a job sent to the runtime. */
export interface Sent {
  subject: string;
  body: string;
}

/**
 * A plugin whose `send` records commands instead of publishing them, so a test
 * can see what a handler reported (and that a stopped handler reported nothing).
 */
export class TestPlugin extends Plugin {
  readonly sent: Sent[] = [];

  constructor(pluginId = "PID") {
    super();
    this.pluginId = pluginId;
  }

  override async send(subject: string, data: Uint8Array): Promise<undefined> {
    this.sent.push({ subject, body: decoder.decode(data) });
    return undefined;
  }

  /** The jobId segment of every command sent, in order. */
  jobIdsSeen(): string[] {
    return this.sent.map((s) => s.subject.split(".")[3] ?? "");
  }
}

export const encode = (v: unknown): Uint8Array =>
  new TextEncoder().encode(typeof v === "string" ? v : JSON.stringify(v));

/** Resolve after the current macrotask queue drains, letting detached work run. */
export const tick = (ms = 0): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/** A deferred, for a handler a test wants to hold open. */
export function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
} {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Capture console.log for the duration of `fn`. */
export async function captureLog(fn: () => void | Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
  };
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return lines;
}

/** A NATS connection double: records subscriptions by subject. */
export class MockConn {
  readonly subs = new Map<string, (err: unknown, msg: Msg) => void>();

  subscribe(subject: string, opts: { callback: (err: unknown, msg: Msg) => void }) {
    this.subs.set(subject, opts.callback);
    return { unsubscribe() {} };
  }

  /** Deliver a message to a subscription, as the server would. */
  deliver(subject: string, msg: MockMsg): void {
    const cb = this.subs.get(subject);
    if (!cb) throw new Error(`nothing subscribed on ${subject}`);
    cb(null, msg.msg);
  }

  /** Install this connection on a plugin, as withDotEnv/withInfraConnection would. */
  attachTo(p: Plugin): void {
    (p as unknown as { infraConn: unknown }).infraConn = { connection: this };
  }
}
