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

/** Wrap a handler so an incoming request is accepted then run. */
export function withJobHandler(
  jobHandler: JobHandler,
): (ar: ActionRequest, msg: Msg) => void | Promise<void> {
  return async (ar: ActionRequest, msg: Msg) => {
    const job = ar.accept(msg);
    await jobHandler(job);
  };
}
