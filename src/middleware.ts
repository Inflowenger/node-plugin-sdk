// Middleware — the functions an action's request runs before the job is
// accepted. Mirrors sdkv1/middleware.go.
import { randomUUID } from "node:crypto";
import type { JobContext } from "./context.js";
import type { Job } from "./job.js";

/**
 * One function of an action's middleware: run for each of the action's requests,
 * in order with the others, **before the job is accepted**. It gets the job's
 * context so far and returns it — with whatever it bound — for the next
 * function, and in the end for the handler (`job.context()`).
 *
 * ```ts
 * function register(ctx: JobContext, job: Job) {
 *   runs.set(job.jobId, { status: "running" }); // before the runtime knows the jobId
 *   return ctx;
 * }
 * ```
 *
 * Returning nothing (or undefined) keeps the context it was given, so a function
 * that only has a side effect needs no return at all.
 *
 * It runs before the job is accepted — before the SDK replies the jobId to the
 * runtime — so nothing can happen to the job (a stop, a query from a later run)
 * before what a function set up under that jobId is in place. That is where
 * per-job registration goes.
 *
 * **Throwing rejects the request**: the runtime gets the error instead of a
 * jobId, and neither the functions after it nor the handler run. (Go's
 * equivalent returns an error; a throw is the same thing here, and a Go panic's
 * recovery too.)
 *
 * The job's context ends when the handler returns, or when the request is
 * rejected: a function that must clean up when the job ends does it with
 * `ctx.onDone(...)` on the context it returns.
 *
 * It may be async, and the SDK awaits it — but the runtime gives up on a jobId
 * it waits too long for (15s), so keep it quick.
 */
export type MiddlewareFunc = (
  ctx: JobContext,
  job: Job,
) => JobContext | void | Promise<JobContext | void>;

/**
 * An ordered list of middleware functions — the value of `Action.middleware`.
 * A plain array works; `use(...)` builds one while skipping empty slots.
 */
export type Middlewares = MiddlewareFunc[];

/**
 * List middleware functions, in the order they run — the helper for
 * `Action.middleware`:
 *
 * ```ts
 * middleware: use(stops.middleware, trace, register),
 * ```
 *
 * A plain array is equally valid (`middleware: [stops.middleware]`); `use`
 * exists to mirror Go's `sdkv1.Use` and to drop undefined/null entries, so a
 * conditionally-built list needs no filtering.
 */
export function use(...fns: Array<MiddlewareFunc | undefined | null>): Middlewares {
  return fns.filter((fn): fn is MiddlewareFunc => typeof fn === "function");
}

/**
 * The key the jobId is bound to on the context. A module-private symbol, so
 * nothing else can read or overwrite it by accident.
 */
const jobIDKey = Symbol("inflow.jobId");

/**
 * The middleware function that names a request's job: it binds a fresh UUID to
 * the context as the jobId (read with `jobIDFromContext`), and the SDK sets
 * `job.jobId` from it, so every function after it sees the job named. Every
 * request runs it first; `withJobID` replaces it, for a plugin that names its
 * jobs its own way.
 */
export const jobID: MiddlewareFunc = (ctx) => withJobIDContext(ctx, randomUUID());

/**
 * `ctx` carrying `jobId` as the job's id. A replacement for `jobID` binds its id
 * with this; the SDK takes `job.jobId` from there.
 */
export function withJobIDContext(ctx: JobContext, jobId: string): JobContext {
  return ctx.withValue(jobIDKey, jobId);
}

/**
 * The jobId bound to `ctx`, or "" — for code deep in a call chain that has the
 * context but not the Job: a logger, a tracer.
 */
export function jobIDFromContext(ctx: JobContext): string {
  const id = ctx.value(jobIDKey);
  return typeof id === "string" ? id : "";
}
