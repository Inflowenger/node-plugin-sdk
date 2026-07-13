// The Job handle passed to an action handler. Mirrors sdkv1/job.go.
import type { Msg } from "nats";
import { Command } from "./types.js";
import type {
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

  /** Complete the job with an error payload. */
  async doneWithError(error: string): Promise<Uint8Array> {
    return this.command(Command.Progress, {
      progress: 100,
      details: { error },
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

  /** Read a slice of context addressed by JSON path (e.g. "$.OPA"). */
  async cmdGetScope(jsonPath: string): Promise<Uint8Array> {
    const sub = this.makeJobSubject(Command.ContextPath);
    const msg = await this.send(sub, encoder.encode(jsonPath));
    return msg.data;
  }

  /** Stop the entire workflow run. */
  async cmdStopFlow(): Promise<Uint8Array> {
    const sub = this.makeJobSubject(Command.Stop);
    const msg = await this.send(sub, new Uint8Array(0));
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
}
