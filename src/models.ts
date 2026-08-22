// Protocol data types. Mirrors sdkv1/models.go + req.go.
// JSON field names are chosen to match the Go wire format exactly, so a Node
// plugin is interchangeable with a Go plugin from the runtime's point of view.

import type { Msg, MsgHdrs } from "nats";
import type { Job } from "./job.js";

/** Anything the runtime can talk to over NATS. Mirrors Go's IPlugin. */
export interface IPlugin {
  send(subject: string, data: Uint8Array): Promise<Msg>;
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
