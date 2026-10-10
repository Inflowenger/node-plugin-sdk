// Protocol data types. Mirrors sdkv1/models.go + req.go.
// JSON field names are chosen to match the Go wire format exactly, so a Node
// plugin is interchangeable with a Go plugin from the runtime's point of view.

import type { Msg, MsgHdrs } from "nats";
import type { Job } from "./job.js";
import type { Middlewares } from "./middleware.js";
import type { Conclusion, PluginSignal } from "./types.js";

/** Anything the runtime can talk to over NATS. Mirrors Go's IPlugin. */
export interface IPlugin {
  send(subject: string, data: Uint8Array): Promise<Msg | undefined>;
  getPluginId(): string;
}

/** A handler for one action execution. Mirrors Go's JobHandler. */
export type JobHandler = (job: Job) => void | Promise<void>;

/** Plugin identity — reply to inflow.v1.<PLUGIN_ID>.@intro. */
export interface PluginIntro {
  name: string;
  author: string;
  version: string;
  /** Optional onboarding form shown when the plugin is first added. */
  settings?: FormBuilder;
  /**
   * Optional Markdown document the host renders on the plugin's page (the
   * FloMorphic Extensions view) — a README/help panel the developer writes to
   * explain the plugin. Beyond prose, the host upgrades a fenced ```inflow-meta
   * block, whose body is a meta method name, into a Run button that calls
   * inflow.v1.<PLUGIN_ID>.<method> through the host proxy and shows the raw JSON
   * reply beneath it. Since the doc author is also the meta author, no extra
   * descriptor is needed — the method name in the fence is enough. Mirrors Go's
   * PluginIntro.Manual.
   */
  manual?: string;
}

/** Icon for an action. */
export interface Icon {
  ref?: string;
  icon?: string;
}

/**
 * Action form configuration — JSON Schema (data model) + UI Schema (layout),
 * rendered by JSON Forms. Reply to inflow.v1.<PLUGIN_ID>.<ACTION>.@form.
 */
export interface FormBuilder {
  /** Name of a meta function for live validation (optional). */
  submit_to?: string;
  /** UI Schema (JSON string). */
  jsonui?: string;
  /** JSON Schema (JSON string). */
  jsonschema?: string;
}

/** A single action the node can perform. */
export interface Action {
  method: string;
  title?: string;
  description?: string;
  icon?: Icon;
  form?: FormBuilder;
  /**
   * Statically declared outbound branches (optional). The whole slice is served
   * on `@actions`, so the frontend renders one output port per entry — labelled
   * by title, explained by description — and stamps every edge drawn from that
   * port with the port's tags. At runtime the handler calls
   * `job.cmdNextFilter(port.tags)` to fire only the branch(es) it names.
   *
   * Leave undefined for the common single-output action.
   */
  outbound?: OutboundPort[];
  /**
   * Open bag of string labels for grouping and classifying an action. It lets a
   * single plugin host several logical products — e.g. a Google plugin bundling
   * Docs, Sheets and Calendar actions — and tell them apart on the `@actions`
   * list.
   *
   * The reserved key `class` names the sub-product an action belongs to, so the
   * frontend can group ports by it: `tags.class = "sheet" | "docs" |
   * "calendar"`. Any other keys are free-form metadata. Optional; leave
   * undefined for a single-class plugin. Mirrors Go's Action.Tags.
   */
  tags?: Record<string, string>;
  /**
   * The action's own middleware functions, run in order after the plugin's
   * (`Plugin.use`) and before the job is accepted — a plain array, or built with
   * `use(fn, ...)`; see MiddlewareFunc. Optional.
   *
   * Excluded from the `@actions` payload like every handler here (see
   * actionsPayload: a function value is dropped by JSON.stringify, but an array
   * of them would marshal as `[null, null]`, so this field is removed by name).
   */
  middleware?: Middlewares;
  /** Not serialized to the wire (functions are dropped by JSON.stringify). */
  requestHandler: JobHandler;
}

/**
 * One statically declared outbound branch of an action. The design-time
 * counterpart of runtime tag routing (Job.cmdNextFilter / `next_tags`).
 * Mirrors Go's OutboundPort.
 */
export interface OutboundPort {
  title: string;
  tags: string[];
  description?: string;
}

/** Plugin-level settings: a form plus a submit handler. */
export interface Settings extends FormBuilder {
  submitHandler?: (req: Request) => Response | Promise<Response>;
}

/**
 * A synchronous request/reply "meta function" (no job, no context access).
 *
 * Unlike a settings submit handler, the handler returns any JSON-able value —
 * the SDK marshals it verbatim. So a meta method can answer with a bare array
 * (e.g. a list of tools), a formkit patch/envelope, or the `{ data, error }`
 * Response envelope, whichever shape the caller expects. Mirrors Go's
 * `RequestHandler func(Request) any`.
 */
export interface Meta {
  method: string;
  requestHandler: (req: Request) => unknown | Promise<unknown>;
}

/** A titled progress frame shown on the canvas. */
export interface Frame {
  title?: string;
  content?: string;
  /**
   * Reserved, open bag for frontend-effective extras the frame wants to render
   * (e.g. an "items" list) without changing the contract. Leave undefined when
   * unused.
   */
  meta?: Record<string, unknown>;
}

/** Payload of a `progress` command. Mirrors Go's CommandPayload. */
export interface CommandPayload {
  progress: number;
  frame?: Frame;
  details?: Record<string, unknown>;
  commit_on?: string;
  /**
   * Set only by the doneWithError family, and what makes a finished job a failed
   * one — `details` is still committed either way.
   */
  error?: ErrorPayload;
}

/**
 * How a terminal command reports a failure. Its presence — not its contents — is
 * the verdict: the core concludes the job failed whenever the field is there,
 * even with an empty message.
 *
 * `code` is the plugin's own error number, in the plugin's own numbering. The
 * core does not interpret it or map it onto a fractal status; it carries it so
 * the plugin's owner can be asked what it means. Leave it 0 when the plugin has
 * no such numbering. Mirrors Go's ErrorPayload.
 */
export interface ErrorPayload {
  code: number;
  message: string;
}

/** Payload of a `commit` command. Mirrors Go's JobBodyContent. */
export interface JobBodyContent {
  jobId?: string;
  progress?: number;
  details?: Record<string, unknown>;
  commit_on?: string;
}

/** Reply shape for meta functions & settings submit. */
export interface Response {
  data?: Record<string, unknown>;
  error?: unknown;
}

/** The raw request delivered to a handler. */
export interface Request {
  data: Uint8Array;
  header?: MsgHdrs;
  plugin: IPlugin;
}

/**
 * The `{ _registry, body }` envelope an execution request arrives in.
 * `body` is the user's form input; `_registry` is runtime metadata
 * (notably this node's previous run). See castRequestTo.
 */
export interface RequestBody<T> {
  _registry: Record<string, unknown>;
  body: T;
}

/** The untyped form of RequestBody — `{ _registry, body }`. Mirrors Go's ActionRequestContent. */
export interface ActionRequestContent {
  _registry: Record<string, unknown>;
  body: Record<string, unknown>;
}

/**
 * Body of a plugin-originated service call (Job.cmdSvcCall). `data` is the
 * payload; `op` carries operation metadata. Mirrors Go's CallSvcBody.
 */
export interface CallSvcBody {
  data: unknown;
  op?: Record<string, unknown>;
}

/**
 * One runtime message on the plugin's signal port,
 * `inflow.plugin.<PLUGIN_ID>.<KIND>` — a broadcast OUT of the runtime about a
 * process, not a request: nothing is expected back and no reply is read.
 *
 * Today the only kind is PluginSignal.Proc, published when the runtime finishes
 * with a plugin node process; the port is a wildcard subscription, so future
 * kinds arrive at the same handler with a different `kind` and, possibly, a
 * payload this type does not model — hence `data`. Mirrors Go's Signal.
 */
export interface Signal {
  /**
   * The subject remainder after `inflow.plugin.<PLUGIN_ID>.`, e.g. "proc".
   * Switch on it before trusting the parsed fields below.
   */
  kind: PluginSignal | string;
  /** The full NATS subject the signal arrived on. */
  subject: string;
  /**
   * The job this signal is about — the very uuid the SDK minted in the
   * request→job handshake and handed to the handler as `job.jobId`, so a plugin
   * can match a signal to the work it still has in flight.
   */
  jobId: string;
  /**
   * How the runtime ended that process. Set for "proc" signals; empty for a kind
   * that carries no conclusion.
   */
  conclusion: Conclusion | string;
  /** The raw payload, kept verbatim so an unmodelled future kind is readable. */
  data: Uint8Array;
  /**
   * The underlying NATS message (headers, subject, reply). Present for the
   * escape hatch; a signal is a publish, so do not respond to it.
   */
  msg: Msg;
}

/**
 * Receives every message that lands on the plugin's signal port. Registered with
 * Plugin.onSignal. Mirrors Go's SignalHandler.
 */
export type SignalHandler = (sig: Signal) => void | Promise<void>;
