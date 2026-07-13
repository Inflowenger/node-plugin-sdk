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
  /** Not serialized to the wire (functions are dropped by JSON.stringify). */
  requestHandler: JobHandler;
}

/** Plugin-level settings: a form plus a submit handler. */
export interface Settings extends FormBuilder {
  submitHandler?: (req: Request) => Response | Promise<Response>;
}

/** A synchronous request/reply "meta function" (no job, no context access). */
export interface Meta {
  method: string;
  requestHandler: (req: Request) => Response | Promise<Response>;
}

/** A titled progress frame shown on the canvas. */
export interface Frame {
  title?: string;
  content?: string;
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
