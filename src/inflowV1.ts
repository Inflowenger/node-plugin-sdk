// Subject wiring: intro / settings / actions / forms / meta. Mirrors sdkv1/inflowV1.go.
import type { Msg } from "nats";
import { background, type JobContext } from "./context.js";
import { Job } from "./job.js";
import { jobIDFromContext, type MiddlewareFunc } from "./middleware.js";
import type { Plugin } from "./plugin.js";
import { ActionRequest } from "./req.js";
import type { Action, Request, Signal } from "./models.js";
import type { Conclusion, PluginSignal } from "./types.js";

const encoder = new TextEncoder();

// ---- subject makers -------------------------------------------------------

/** inflow.v1.<PLUGIN_ID>.<action> — meta functions & settings submit. */
export const makeActionSubject = (pluginId: string, action: string): string =>
  `inflow.v1.${pluginId}.${action}`;

/** inflow.v1.<PLUGIN_ID>.@settings */
export const makeSettingsSubject = (pluginId: string): string =>
  `inflow.v1.${pluginId}.@settings`;

/** inflow.v1.<PLUGIN_ID>.@actions */
export const makeActionsListSubject = (pluginId: string): string =>
  `inflow.v1.${pluginId}.@actions`;

/** inflow.v1.<PLUGIN_ID>.@intro */
export const makeIntroSubject = (pluginId: string): string =>
  `inflow.v1.${pluginId}.@intro`;

/** inflow.cpu.<PLUGIN_ID>.<ACTION> — the runtime's execution call. */
export const makeActionCpu = (pluginId: string, action: string): string =>
  `inflow.cpu.${pluginId}.${action}`;

/** inflow.plugin.<PLUGIN_ID>.> — the wildcard signal port (every signal kind). */
export const makeSignalSubject = (pluginId: string): string =>
  `inflow.plugin.${pluginId}.>`;

/** inflow.v1.<PLUGIN_ID>.<ACTION>.@form */
export const makeFormSubject = (pluginId: string, action: string): string =>
  `inflow.v1.${pluginId}.${action}.@form`;

// ---- handlers -------------------------------------------------------------

const json = (v: unknown): Uint8Array => encoder.encode(JSON.stringify(v));

function reqFrom(p: Plugin, msg: Msg): Request {
  return { data: msg.data, header: msg.headers, plugin: p };
}

export function introHandler(p: Plugin): void {
  const nc = p.infraConn.connection;
  nc.subscribe(makeIntroSubject(p.pluginId), {
    callback: (_err, msg) => {
      msg.respond(json(p.introData));
    },
  });
}

export function settingsHandler(p: Plugin): void {
  const nc = p.infraConn.connection;

  // show the settings form. A plugin that requires nothing still answers, with
  // an empty object: an empty body is not JSON, so a caller could not tell
  // "asks for nothing" from "not running".
  nc.subscribe(makeSettingsSubject(p.pluginId), {
    callback: (_err, msg) => {
      if (!p.settingsData) {
        msg.respond(encoder.encode("{}"));
        return;
      }
      msg.respond(json(p.settingsData));
    },
  });

  // settings submit handler
  if (p.settingsData) {
    if (!p.settingsData.submit_to || p.settingsData.submit_to.trim() === "") {
      p.settingsData.submit_to = "_settings.config.submit";
    }
    nc.subscribe(makeActionSubject(p.pluginId, p.settingsData.submit_to), {
      callback: async (_err, msg) => {
        const settings = p.settingsData!;
        if (!settings.submitHandler) {
          msg.respond(encoder.encode(`{"status":"not implemented"}`));
          return;
        }
        try {
          const res = await settings.submitHandler(reqFrom(p, msg));
          msg.respond(json(res));
        } catch {
          msg.respond(
            encoder.encode(`{"error":"error occurred in submit handler"}`),
          );
        }
      },
    });
  }
}

/**
 * The `@actions` payload: the action list as the frontend reads it, minus the
 * fields that are code rather than description. JSON.stringify drops a function
 * value on its own (`requestHandler`), but an ARRAY of functions marshals as
 * `[null, null]` — so `middleware` is removed by name here.
 */
export function actionsPayload(actions: Action[]): unknown[] {
  return actions.map((action) => {
    const { middleware: _middleware, requestHandler: _requestHandler, ...rest } = action;
    return rest;
  });
}

export function actionsHandler(p: Plugin): void {
  const nc = p.infraConn.connection;

  // list of all actions
  nc.subscribe(makeActionsListSubject(p.pluginId), {
    callback: (_err, msg) => {
      msg.respond(json(actionsPayload(p.actions)));
    },
  });

  for (const action of p.actions) {
    // this action's form
    nc.subscribe(makeFormSubject(p.pluginId, action.method), {
      callback: (_err, msg) => {
        msg.respond(json(action.form ?? {}));
      },
    });
    console.log(`Form Builder Service : ${makeFormSubject(p.pluginId, action.method)}`);

    // execution: run the request's middleware, ack the jobId, then the handler
    nc.subscribe(makeActionCpu(p.pluginId, action.method), {
      callback: (_err, msg) => {
        dispatchAction(p, action, msg);
      },
    });
    console.log(`Subscribed Action : ${makeActionCpu(p.pluginId, action.method)}`);
  }
}

/**
 * Start one execution request's pipeline. nats.js invokes a subscription
 * callback without awaiting it, so the promise is deliberately not awaited
 * (`void`): neither this request's middleware nor its handler holds up the
 * requests behind it on the subscription. Mirrors Go's dispatchAction.
 */
export function dispatchAction(p: Plugin, action: Action, msg: Msg): void {
  if (!action.requestHandler) {
    // Say so, rather than leave the runtime waiting out its 15s accept budget
    // for a jobId that is never coming. Mirrors Go.
    new ActionRequest("", action.method, reqFrom(p, msg)).reject(
      msg,
      `{"error":"action not implemented"}`,
    );
    console.log(`recv new request message on action ${action.method}: no requestHandler`);
    return;
  }
  void runPipeline(p, action, reqFrom(p, msg), msg);
}

/**
 * Run a request's middleware functions in order (Plugin.pipeline), then accept
 * the job — reply the jobId — and run the handler. The job's context begins here
 * and ends when this returns: once the handler has, or as soon as the request is
 * rejected. Mirrors Go's runPipeline.
 */
export async function runPipeline(
  p: Plugin,
  action: Action,
  req: Request,
  msg: Msg,
): Promise<void> {
  const [ctx, end] = background().withCancel();
  try {
    let job: Job;
    let accepted: JobContext;
    try {
      [accepted, job] = await runMiddleware(p, action, ctx, new Job(p, action.method, "", req));
    } catch (err) {
      rejectRequest(p, action, msg, err);
      return;
    }

    const ar = new ActionRequest(job.jobId, job.action, job.req);
    const live = ar.accept(msg).withContext(accepted);
    try {
      await action.requestHandler(live);
    } catch (err) {
      if (accepted.canceled) {
        // The job was stopped: an aborted fetch (or ctx.throwIfCanceled) threw
        // its way out of the handler. The runtime has already concluded this job
        // and stopped listening, so reporting would only retry against a subject
        // with no responder. (In Go a cancellation is a returned error the
        // handler inspects, so this path cannot arise there.)
        console.log(`job ${live.jobId} ended by cancellation:`, err);
        return;
      }
      // Accepted: the runtime is waiting on the job, so a throw is its failure —
      // never swallowed, or the runtime hangs waiting for a result that never
      // comes. (doneWithError goes through Plugin.send, which reports rather
      // than throws, so this cannot itself crash the plugin.)
      await live.doneWithError(err instanceof Error ? err.message : String(err));
    }
  } finally {
    end();
  }
}

/**
 * Run the request's middleware functions in order, each on the context the one
 * before returned, keeping `job.jobId` in step with the jobId bound to the
 * context. The first throw stops it, and so does a job no function named.
 * Mirrors Go's runMiddleware.
 */
async function runMiddleware(
  p: Plugin,
  action: Action,
  ctx: JobContext,
  job: Job,
): Promise<[JobContext, Job]> {
  for (const fn of p.pipeline(action)) {
    const next = await runMiddlewareFunc(fn, ctx, job);
    if (next) ctx = next;
    const id = jobIDFromContext(ctx);
    if (id !== "" && id !== job.jobId) job = job.withJobId(id);
  }
  if (job.jobId === "") {
    throw new Error(
      "no jobId: the first middleware function (jobID, or withJobID's) bound none",
    );
  }
  return [ctx, job];
}

/**
 * Run one middleware function. A synchronous throw and a rejected promise are
 * one and the same here — both reject the request — which is what Go gets from
 * an error return plus panic recovery.
 */
async function runMiddlewareFunc(
  fn: MiddlewareFunc,
  ctx: JobContext,
  job: Job,
): Promise<JobContext | void> {
  return await fn(ctx, job);
}

/** Answer a request with an error instead of a jobId. Mirrors Go's rejectRequest. */
function rejectRequest(p: Plugin, action: Action, msg: Msg, err: unknown): void {
  const reason = err instanceof Error ? err.message : String(err);
  console.log(`action ${action.method} rejected: ${reason}`);
  new ActionRequest("", action.method, reqFrom(p, msg)).reject(
    msg,
    JSON.stringify({ error: reason }),
  );
}

export function metaFuncHandler(p: Plugin): void {
  const nc = p.infraConn.connection;
  for (const meta of p.metaFn) {
    nc.subscribe(makeActionSubject(p.pluginId, meta.method), {
      callback: async (_err, msg) => {
        try {
          const res = await meta.requestHandler(reqFrom(p, msg));
          msg.respond(json(res));
        } catch {
          msg.respond(
            encoder.encode(`{"error":"error occurred in marshal response"}`),
          );
        }
      },
    });
    console.log(`Meta Function Service : ${makeActionSubject(p.pluginId, meta.method)}`);
  }
}

/**
 * Subscribe the registered signal handler (Plugin.onSignal) to the whole signal
 * port, `inflow.plugin.<PLUGIN_ID>.>`. A plugin that never called onSignal
 * subscribes to nothing — the port is opt-in. Mirrors Go's signalsHandler.
 */
export function signalsHandler(p: Plugin): void {
  const handler = p.signalFn;
  if (!handler) {
    console.log(signalPortNote(p));
    return;
  }
  const nc = p.infraConn.connection;
  nc.subscribe(makeSignalSubject(p.pluginId), {
    callback: (_err, msg) => {
      const sig = parseSignal(p.pluginId, msg);
      // A signal handler that blocks (closing a stream, aborting an upstream
      // call) must not stall the signals behind it, and a rejected promise here
      // would surface as an unhandled rejection that crashes the plugin.
      void (async () => {
        try {
          await handler(sig);
        } catch (err) {
          console.log(`signal handler failed on ${sig.subject}:`, err);
        }
      })();
    },
  });
  console.log(`Signals Subscribed on : ${makeSignalSubject(p.pluginId)}`);
}

/**
 * What start() logs when no onSignal handler is registered. The port then has no
 * subscription, so no signal reaches the plugin — harmless for most plugins, but
 * a stop capability added as middleware (jobstop's) then silently never fires.
 * Naming where middleware is added points at the likely victims. Mirrors Go's
 * signalPortNote.
 */
export function signalPortNote(p: Plugin): string {
  let note =
    `Signals not subscribed on : ${makeSignalSubject(p.pluginId)} ` +
    `(no onSignal handler registered: no stop will reach any job)`;
  if (p.middlewares.length > 0) note += "; plugin middleware is set";
  const withMiddleware = p.actions
    .filter((a) => (a.middleware?.length ?? 0) > 0)
    .map((a) => a.method);
  if (withMiddleware.length > 0) {
    note += `; actions with middleware: ${withMiddleware.join(", ")}`;
  }
  return note;
}

/**
 * Turn a raw signal message into a Signal: `kind` is whatever the subject
 * carries past the plugin's prefix, and a payload that parses as the runtime's
 * `{conclusion, jobId}` body fills the typed fields. A payload that does not
 * parse is not an error — an unmodelled future kind still reaches the handler
 * with its bytes intact.
 */
export function parseSignal(pluginId: string, msg: Msg): Signal {
  const sig: Signal = {
    kind: msg.subject.startsWith(`inflow.plugin.${pluginId}.`)
      ? (msg.subject.slice(`inflow.plugin.${pluginId}.`.length) as PluginSignal)
      : msg.subject,
    subject: msg.subject,
    jobId: "",
    conclusion: "",
    data: msg.data,
    msg,
  };
  try {
    const body = JSON.parse(new TextDecoder().decode(msg.data)) as {
      conclusion?: string;
      jobId?: string;
    };
    if (body && typeof body === "object") {
      sig.jobId = body.jobId ?? "";
      sig.conclusion = (body.conclusion ?? "") as Conclusion;
    }
  } catch {
    /* an unmodelled kind: leave the typed fields empty, keep data */
  }
  return sig;
}
