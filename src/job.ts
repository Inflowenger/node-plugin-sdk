// The Job handle passed to an action handler. Mirrors sdkv1/job.go.
import type { Msg } from "nats";
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

  constructor(plugin: IPlugin, action: string, jobId: string, req: Request) {
    this.plugin = plugin;
    this.action = action;
    this.jobId = jobId;
    this.req = req;
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

  /** End the job as failed, reporting the reason as its only detail. */
  async doneWithError(error: string): Promise<Uint8Array> {
    return this.doneWithErrorData(error, null);
  }

  /**
   * End the job as failed exactly like doneWithError, but keep a payload: `data`
   * is reported (and committed, at `key` when given) next to the reason, which
   * always lands on the canonical "error" detail — so a key named "error" inside
   * `data` is overwritten.
   *
   * Use it when the failure still carries something the flow needs: a terminal
   * command's details ARE what gets committed onto the node's scope, so a bare
   * doneWithError reports only "error" and anything the node had persisted there
   * (a conversation, a cursor) is gone by the next read. Hand it back through
   * `data` to keep it.
   */
  async doneWithErrorData(
    error: string,
    data: Record<string, unknown> | null,
    ...key: string[]
  ): Promise<Uint8Array> {
    const details: Record<string, unknown> = { ...(data ?? {}) };
    details.error = error;
    return this.command(Command.Progress, {
      progress: 100,
      details,
      commit_on: key.join("."),
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
    return msg.data;
  }

  /**
   * Fire only the outbound branch(es) whose tags are named — the runtime
   * counterpart of Action.outbound. Edges carrying other tags are skipped.
   */
  async cmdNextFilter(nextsTags: string[]): Promise<Uint8Array> {
    const sub = this.makeJobSubject(Command.NextTags);
    const msg = await this.send(sub, encoder.encode(nextsTags.join(",")));
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
    return msg.data;
  }

  /** Read a slice of context addressed by JSON path (e.g. "$.OPA"). */
  async cmdGetScope(jsonPath: string): Promise<Uint8Array> {
    const sub = this.makeJobSubject(Command.ContextPath);
    const msg = await this.send(sub, encoder.encode(jsonPath));
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
    return msg.data;
  }

  /** Low-level: send a command payload to the runtime for this job. */
  async command(cmd: Command, data: CommandPayload): Promise<Uint8Array> {
    const sub = this.makeJobSubject(cmd);
    const msg = await this.send(sub, encoder.encode(JSON.stringify(data)));
    return msg.data;
  }

  private send(sub: string, data: Uint8Array): Promise<Msg> {
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
