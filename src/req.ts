// Request parsing and the request -> job handshake. Mirrors sdkv1/req.go.
import type { Msg } from "nats";
import { Job } from "./job.js";
import type { JobHandler, Request, RequestBody } from "./models.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** An incoming action execution, before it's accepted as a Job. */
export class ActionRequest {
  jobId: string;
  action: string;
  req: Request;

  constructor(jobId: string, action: string, req: Request) {
    this.jobId = jobId;
    this.action = action;
    this.req = req;
  }

  /** Acknowledge the request with its jobId and return the live Job. */
  accept(msg: Msg): Job {
    const job = new Job(this.req.plugin, this.action, this.jobId, this.req);
    msg.respond(encoder.encode(JSON.stringify({ jobId: this.jobId })));
    return job;
  }

  /** Reject the request, replying with a cause. */
  reject(msg: Msg, cause: string): void {
    msg.respond(encoder.encode(cause));
  }
}

/**
 * Decode a raw request body into a typed `{ _registry, body }` envelope.
 * Mirrors Go's generic CastRequestTo[T].
 */
export function castRequestTo<T>(data: Uint8Array): RequestBody<T> {
  return JSON.parse(decoder.decode(data)) as RequestBody<T>;
}

/**
 * Wrap a handler so an incoming request is accepted then run.
 *
 * Kept for compatibility — and for a plugin that drives the handshake itself.
 * The SDK's own request path is `runPipeline` in inflowV1.ts, which runs the
 * action's middleware before accepting; this skips that, so a job it accepts has
 * no middleware context (`job.context()` is the background context) and nothing
 * `jobstop` can cancel. Pass actions through `Plugin.addAction` to get the
 * pipeline.
 *
 * The jobId is acked synchronously (accept() runs before the first await), and
 * the actual work runs concurrently: nats.js invokes subscription callbacks
 * without awaiting them, so the caller fire-and-forgets this promise (`void`) and
 * concurrent calls to the same action do not serialize. Because it is not
 * awaited, a throw or rejection here would surface as an unhandledRejection and
 * can crash the process — so once the jobId is assigned the failure is reported
 * back to the runtime as doneWithError instead (mirrors Go/Python). The runtime
 * is waiting on a terminal command, so a swallowed error would hang it.
 */
export function withJobHandler(
  jobHandler: JobHandler,
): (ar: ActionRequest, msg: Msg) => void | Promise<void> {
  return async (ar: ActionRequest, msg: Msg) => {
    const job = ar.accept(msg);
    try {
      await jobHandler(job);
    } catch (e) {
      await job.doneWithError(e instanceof Error ? e.message : String(e));
    }
  };
}
