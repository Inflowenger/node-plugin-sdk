// The Job handle passed to an action handler. Mirrors sdkv1/job.go.
import type { Msg } from "nats";
import { background, type JobContext } from "./context.js";
import { Command } from "./types.js";
import type {
  CallSvcBody,
  CommandPayload,
  Frame,
  IPlugin,
  JobBodyContent,
  Request,
} from "./models.js";

const encoder = new TextEncoder();

export class Job {
  readonly plugin: IPlugin;
  readonly action: string;
  readonly jobId: string;
  readonly req: Request;
  private readonly ctx?: JobContext;

  constructor(
    plugin: IPlugin,
    action: string,
    jobId: string,
    req: Request,
    ctx?: JobContext,
  ) {
    this.plugin = plugin;
    this.action = action;
    this.jobId = jobId;
    this.req = req;
    this.ctx = ctx;
  }

  /**
   * The job's context: the one its middleware passed down (see MiddlewareFunc),
   * carrying the jobId (`jobIDFromContext`) and whatever the middleware bound to
   * it, and ended by the SDK when the handler returns. A job built by hand — and
   * one from an action with no middleware — answers the background context,
   * which is never cancelled, so a handler may call this unconditionally.
   *
   * Like an `http.Request`'s, it lives as long as the handler: work the handler
   * leaves running after it returns must not hold it — derive that work's
   * context with `ctx.withoutCancel()`, which keeps the values (a trace) and
   * drops the cancellation.
   */
  context(): JobContext {
    return this.ctx ?? background();
  }

  /**
   * A copy of the job carrying `ctx` as its `context()`. The SDK uses it to hand
   * a handler what its middleware passed down; a handler can use it to pass a
   * narrowed context along with the job.
   */
  withContext(ctx: JobContext): Job {
    return new Job(this.plugin, this.action, this.jobId, this.req, ctx);
  }

  /**
   * A copy of the job named `jobId`. The SDK uses it to keep `job.jobId` in step
   * with the id bound to the context after each middleware function; a handler
   * has no reason to call it — renaming an accepted job would address its
   * commands to a job the runtime does not know.
   */
  withJobId(jobId: string): Job {
    return new Job(this.plugin, this.action, jobId, this.req, this.ctx);
  }

  /** Complete the job (progress 100) and emit `data` as this node's output. */
  async done(
    data: Record<string, unknown>,
    ...key: string[]
  ): Promise<Uint8Array> {
    return this.command(Command.Progress, {
      progress: 100,
      details: data,
      commit_on: key.join("."),
    });
  }

  /**
   * End the job as failed, reporting `error` as the reason.
   *
   * The reason no longer travels as a detail: it goes in the command's own
   * `error` field, and `details` is left untouched. So the job commits nothing
   * and the flow sees a failure with a message.
   */
  async doneWithError(error: string): Promise<Uint8Array> {
    return this.doneWithErrorCode(0, error, null);
  }

  /**
   * End the job as failed exactly like doneWithError, but keep a payload: `data`
   * is reported (and committed, at `key` when given) alongside the reason.
   * Nothing in `data` is reserved — the reason rides on its own field, so a key
   * named "error" is now the plugin's to use.
   *
   * Use it when the failure still carries something the flow needs: a terminal
   * command's details ARE what gets committed onto the node's scope, so a bare
   * doneWithError commits nothing and anything the node had persisted there (a
   * conversation, a cursor) is gone by the next read. Hand it back through
   * `data` to keep it.
   */
  async doneWithErrorData(
    error: string,
    data: Record<string, unknown> | null,
    ...key: string[]
  ): Promise<Uint8Array> {
    return this.doneWithErrorCode(0, error, data, ...key);
  }

  /**
   * doneWithErrorData with the plugin's own error number attached. `code`
   * belongs to the plugin's numbering — the core carries it next to the message
   * and never interprets it — so pass 0 when the plugin has none.
   */
  async doneWithErrorCode(
    code: number,
    error: string,
    data: Record<string, unknown> | null,
    ...key: string[]
  ): Promise<Uint8Array> {
    return this.command(Command.Progress, {
      progress: 100,
      details: data ?? undefined,
      commit_on: key.join("."),
      error: { code, message: error },
    });
  }

  /**
   * Report progress. 100 or greater finishes the job. `frame` is a titled
   * status shown on the canvas.
   */
  async progress(progressPercent: number, frame: Frame): Promise<Uint8Array> {
    return this.command(Command.Progress, { progress: progressPercent, frame });
  }

  /** Read the whole current context scope (raw bytes). */
  async cmdGetCurrentScope(): Promise<Uint8Array> {
    const sub = this.makeJobSubject(Command.ContextCurrent);
    const msg = await this.send(sub, new Uint8Array(0));
    if (!msg) return new Uint8Array(0);
    return msg.data;
  }

  /**
   * Fire only the outbound branch(es) whose tags are named — the runtime
   * counterpart of Action.outbound. Edges carrying other tags are skipped.
   */
  async cmdNextFilter(nextsTags: string[]): Promise<Uint8Array> {
    const sub = this.makeJobSubject(Command.NextTags);
    const msg = await this.send(sub, encoder.encode(nextsTags.join(",")));
    if (!msg) return new Uint8Array(0);
    return msg.data;
  }

  /**
   * Make a plugin-originated call to a downstream service. `action` names the
   * service, `data` is the payload, `opData` carries operation metadata.
   */
  async cmdSvcCall(
    action: string,
    data: unknown,
    opData?: Record<string, unknown>,
  ): Promise<Uint8Array> {
    if (action.trim() === "") {
      throw new Error("invalid subject");
    }
    const envelope: CallSvcBody = { data, op: opData };
    const sub = this.makeCallSvcSubject(action);
    const msg = await this.send(sub, encoder.encode(JSON.stringify(envelope)));
    if (!msg) return new Uint8Array(0);
    return msg.data;
  }

  /** Read a slice of context addressed by JSON path (e.g. "$.OPA"). */
  async cmdGetScope(jsonPath: string): Promise<Uint8Array> {
    const sub = this.makeJobSubject(Command.ContextPath);
    const msg = await this.send(sub, encoder.encode(jsonPath));
    if (!msg) return new Uint8Array(0);
    return msg.data;
  }

  /** Commit data into the flow context at a JSON path. */
  async cmdSetOnPath(
    jsonPath: string,
    data: Record<string, unknown>,
  ): Promise<Uint8Array> {
    const content: JobBodyContent = { commit_on: jsonPath, details: data };
    const sub = this.makeJobSubject(Command.Commit);
    const msg = await this.send(sub, encoder.encode(JSON.stringify(content)));
    if (!msg) return new Uint8Array(0);
    return msg.data;
  }

  /** Low-level: send a command payload to the runtime for this job. */
  async command(cmd: Command, data: CommandPayload): Promise<Uint8Array> {
    const sub = this.makeJobSubject(cmd);
    const msg = await this.send(sub, encoder.encode(JSON.stringify(data)));
    if (!msg) return new Uint8Array(0);
    return msg.data;
  }

  private send(sub: string, data: Uint8Array): Promise<Msg | undefined> {
    return this.plugin.send(sub, data);
  }

  /** inflow.cpu.<PLUGIN_ID>.<JOB_ID>.<cmd> */
  private makeJobSubject(cmd: Command): string {
    return `inflow.cpu.${this.plugin.getPluginId()}.${this.jobId}.${cmd}`;
  }

  /** inflow.cpu.<PLUGIN_ID>.<JOB_ID>.request/svc.<action> */
  private makeCallSvcSubject(action: string): string {
    return `inflow.cpu.${this.plugin.getPluginId()}.${this.jobId}.${Command.Request}.${action}`;
  }
}
