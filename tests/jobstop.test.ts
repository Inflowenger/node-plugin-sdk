// jobstop, and the two patterns built on it: a job named by an external service,
// and work observed across runs. The Node counterpart of
// jobstop/jobstop_test.go + sdkv1/{jobstop,externalid,detached}_integration_test.go.
import assert from "node:assert/strict";
import test from "node:test";
import {
  canceled,
  castRequestTo,
  chainSignals,
  jobstop,
  runPipeline,
  use,
  withJobIDContext,
  type Action,
  type Job,
  type JobContext,
  type Signal,
} from "../src/index.js";
import { captureLog, deferred, MockConn, MockMsg, TestPlugin, tick } from "./harness.js";

const proc = (jobId: string, conclusion: string): Signal =>
  ({
    kind: "proc",
    subject: "inflow.plugin.PID.proc",
    jobId,
    conclusion,
    data: new TextEncoder().encode(JSON.stringify({ jobId, conclusion })),
  }) as Signal;

/** Run one request through p's pipeline. Returns the msg and the promise. */
function start(
  p: TestPlugin,
  action: Partial<Action>,
  body?: unknown,
): { msg: MockMsg; done: Promise<void> } {
  const data =
    body === undefined ? new Uint8Array() : new TextEncoder().encode(JSON.stringify(body));
  const msg = new MockMsg("inflow.cpu.PID.run", data);
  const full: Action = {
    method: action.method ?? "run",
    requestHandler: action.requestHandler ?? (() => {}),
    middleware: action.middleware,
  };
  return { msg, done: runPipeline(p, full, { data, plugin: p }, msg.msg) };
}

// ---- the registry on its own ----------------------------------------------

test("a stop cancels the job it names, with ErrStopped as the cause", async () => {
  const stops = new jobstop.Registry();
  const p = new TestPlugin();
  const held = deferred();
  let ctx!: JobContext;

  const { msg, done } = start(p, {
    middleware: use(stops.middleware),
    requestHandler: async (job: Job) => {
      ctx = job.context();
      await held.promise;
    },
  });
  await tick();
  const jobId = msg.reply().jobId!;
  assert.equal(stops.size, 1);
  assert.equal(ctx.canceled, false);

  await captureLog(() => stops.onSignal(proc(jobId, "flow_stop_by_user")));
  assert.equal(ctx.canceled, true);
  assert.equal(ctx.cause, jobstop.ErrStopped);
  assert.equal(stops.size, 0, "a stopped job leaves the registry");
  held.resolve();
  await done;
});

test("stops are isolated by jobId — another flow's signal does nothing", async () => {
  const stops = new jobstop.Registry();
  const p = new TestPlugin();
  const held = deferred();
  let ctx!: JobContext;
  const { done } = start(p, {
    middleware: use(stops.middleware),
    requestHandler: async (job: Job) => {
      ctx = job.context();
      await held.promise;
    },
  });
  await tick();
  stops.onSignal(proc("a-job-this-process-never-accepted", "flow_stop_by_user"));
  assert.equal(ctx.canceled, false);
  assert.equal(stops.size, 1);
  held.resolve();
  await done;
});

test("an ending that is not a cancellation unfiles without cancelling", async () => {
  const stops = new jobstop.Registry();
  const p = new TestPlugin();
  const held = deferred();
  let ctx!: JobContext;
  const { msg, done } = start(p, {
    middleware: use(stops.middleware),
    requestHandler: async (job: Job) => {
      ctx = job.context();
      await held.promise;
    },
  });
  await tick();
  const lines = await captureLog(() => stops.onSignal(proc(msg.reply().jobId!, "done")));
  assert.equal(ctx.canceled, false, "a finishing job must not be cut short");
  assert.equal(stops.size, 0);
  assert.deepEqual(lines, [], "and nothing is logged");
  held.resolve();
  await done;
});

test("signals the SDK does not model are ignored", () => {
  const stops = new jobstop.Registry();
  stops.onSignal({ kind: "future", subject: "s", jobId: "x", conclusion: "", data: new Uint8Array() } as Signal);
  stops.onSignal(proc("", "flow_stop_by_user"));
  assert.equal(stops.size, 0);
});

test("a job leaves the registry when its context ends on its own", async () => {
  const stops = new jobstop.Registry();
  const p = new TestPlugin();
  const { done } = start(p, { middleware: use(stops.middleware) });
  await done;
  await tick();
  assert.equal(stops.size, 0);
});

test("cancelAll cancels every job it holds, with ErrShutdown", async () => {
  const stops = new jobstop.Registry();
  const p = new TestPlugin();
  const held = deferred();
  const contexts: JobContext[] = [];
  const runs = [0, 1, 2].map(() =>
    start(p, {
      middleware: use(stops.middleware),
      requestHandler: async (job: Job) => {
        contexts.push(job.context());
        await held.promise;
      },
    }),
  );
  await tick();
  assert.equal(stops.size, 3);
  stops.cancelAll();
  assert.equal(stops.size, 0);
  assert.deepEqual(
    contexts.map((c) => c.cause),
    [jobstop.ErrShutdown, jobstop.ErrShutdown, jobstop.ErrShutdown],
  );
  held.resolve();
  await Promise.all(runs.map((r) => r.done));
});

// ---- the registry in the pipeline -----------------------------------------

test("the job is filed before the runtime is told its jobId", async () => {
  const stops = new jobstop.Registry();
  const p = new TestPlugin();
  let filedWhileUnaccepted = false;
  const { done } = start(p, {
    // Anything after stops.middleware still runs before the accept reply, so
    // this is the window a stop could arrive in — and the job is already filed.
    middleware: use(stops.middleware, (ctx, job) => {
      filedWhileUnaccepted = stops.size === 1 && job.jobId !== "";
      return ctx;
    }),
  });
  await done;
  assert.equal(filedWhileUnaccepted, true);
});

test("jobstop is per action: an action without it is not stoppable", async () => {
  const stops = new jobstop.Registry();
  const p = new TestPlugin();
  const held = deferred();
  let ctx!: JobContext;
  const { msg, done } = start(p, {
    method: "detached",
    requestHandler: async (job: Job) => {
      ctx = job.context();
      await held.promise;
    },
  });
  await tick();
  stops.onSignal(proc(msg.reply().jobId!, "flow_stop_by_user"));
  assert.equal(ctx.canceled, false, "the job keeps running, by design");
  held.resolve();
  await done;
});

test("a stopped handler reports nothing to the runtime", async () => {
  const stops = new jobstop.Registry();
  const p = new TestPlugin();
  const { msg, done } = start(p, {
    middleware: use(stops.middleware),
    requestHandler: async (job: Job) => {
      const ctx = job.context();
      // A polling loop, exactly as the docs write it.
      for (;;) {
        if (!(await ctx.sleep(10_000))) break;
        await job.progress(10, { title: "t", content: "c" });
      }
      if (ctx.canceled) return; // the runtime is gone: do not report
      await job.done({ ok: true });
    },
  });
  await tick();
  await captureLog(() => stops.onSignal(proc(msg.reply().jobId!, "timeout")));
  await done;
  assert.deepEqual(p.sent, [], "no progress, no done — the subject has no responder");
});

test("the stop is logged once, with the conclusion that caused it", async () => {
  const stops = new jobstop.Registry();
  const p = new TestPlugin();
  const held = deferred();
  const { msg, done } = start(p, {
    middleware: use(stops.middleware),
    requestHandler: async () => {
      await held.promise;
    },
  });
  await tick();
  const jobId = msg.reply().jobId!;
  const lines = await captureLog(() => stops.onSignal(proc(jobId, "stop_command")));
  assert.equal(lines.length, 1);
  assert.equal(
    lines[0],
    `jobstop: job ${jobId} cancelled: the runtime concluded its process stop_command`,
  );
  held.resolve();
  await done;
});

test("jobstop composes with other handlers on the one port", async () => {
  const stops = new jobstop.Registry();
  const p = new TestPlugin();
  const held = deferred();
  const audited: string[] = [];
  let ctx!: JobContext;
  const port = chainSignals(stops.onSignal, (sig) => {
    if (canceled(sig.conclusion)) audited.push(sig.jobId);
  });
  const { msg, done } = start(p, {
    middleware: use(stops.middleware),
    requestHandler: async (job: Job) => {
      ctx = job.context();
      await held.promise;
    },
  });
  await tick();
  const jobId = msg.reply().jobId!;
  await captureLog(() => port(proc(jobId, "flow_stop_by_user")));
  assert.equal(ctx.cause, jobstop.ErrStopped);
  assert.deepEqual(audited, [jobId]);
  held.resolve();
  await done;
});

// ---- one id across two systems (external-job-identity) --------------------

/** A stand-in for a service that names work itself and can be told to drop it. */
class FakeJoern {
  private next = 1;
  readonly live = new Set<string>();
  readonly aborted: string[] = [];
  registerFails = false;
  idPrefix = "q-8f21c47b3d";

  register(): string {
    if (this.registerFails) throw new Error("joern refused the query");
    const id = `${this.idPrefix}-${this.next++}`;
    this.live.add(id);
    return id;
  }

  has(id: string): boolean {
    return this.live.has(id);
  }

  cancel(id: string): void {
    this.aborted.push(id);
    this.live.delete(id);
  }
}

interface QueryInput {
  project: string;
  query: string;
}

function namer(joern: FakeJoern): (ctx: JobContext, job: Job) => JobContext {
  return (ctx, job) => {
    const body = job.req.data.length
      ? castRequestTo<QueryInput>(job.req.data)
      : { _registry: undefined, body: undefined };
    const prev = (body._registry as { jobId?: string } | undefined)?.jobId;
    if (prev && joern.has(prev)) return withJobIDContext(ctx, prev);
    const id = joern.register();
    if (id.length < 10) {
      joern.cancel(id); // never accepted: undo it
      throw new Error(`jobId ${id} from joern is shorter than 10 characters`);
    }
    return withJobIDContext(ctx, id);
  };
}

test("the service's id becomes the jobId, on the wire and in the commands", async () => {
  const joern = new FakeJoern();
  const stops = new jobstop.Registry();
  const p = new TestPlugin();
  const { msg, done } = start(
    p,
    {
      middleware: use(namer(joern), stops.middleware),
      requestHandler: async (job: Job) => {
        await job.done({ queryId: job.jobId }, "joern");
      },
    },
    { body: { project: "acme/api", query: "cpg.method" } },
  );
  await done;
  const jobId = msg.reply().jobId!;
  assert.equal(jobId, "q-8f21c47b3d-1");
  assert.deepEqual(p.jobIdsSeen(), [jobId], "the command subject carries the service's id");
});

test("a stop reaches the service with no local lookup table", async () => {
  const joern = new FakeJoern();
  const stops = new jobstop.Registry();
  const p = new TestPlugin();
  const held = deferred();

  // Stateless: the signal already names the query.
  const abortUpstream = (sig: Signal) => {
    if (sig.kind !== "proc" || !canceled(sig.conclusion)) return;
    joern.cancel(sig.jobId);
  };
  const port = chainSignals(stops.onSignal, abortUpstream);

  const { msg, done } = start(
    p,
    {
      middleware: use(namer(joern), stops.middleware),
      requestHandler: async () => {
        await held.promise;
      },
    },
    { body: {} },
  );
  await tick();
  const jobId = msg.reply().jobId!;
  await captureLog(() => port(proc(jobId, "flow_stop_by_user")));
  assert.deepEqual(joern.aborted, [jobId]);
  held.resolve();
  await done;
});

test("filing before the namer misses the stop — the ordering rule, as a test", async () => {
  const joern = new FakeJoern();
  const stops = new jobstop.Registry();
  const p = new TestPlugin();
  const held = deferred();
  let ctx!: JobContext;
  const { msg, done } = start(
    p,
    {
      // WRONG ON PURPOSE: stops.middleware files the uuid, the wire carries the
      // query id, and the stop matches nothing.
      middleware: use(stops.middleware, namer(joern)),
      requestHandler: async (job: Job) => {
        ctx = job.context();
        await held.promise;
      },
    },
    { body: {} },
  );
  await tick();
  stops.onSignal(proc(msg.reply().jobId!, "flow_stop_by_user"));
  assert.equal(ctx.canceled, false, "the stop was lost: this is why the namer comes first");
  held.resolve();
  await done;
});

test("a registration failure rejects the request — the node never ran", async () => {
  const joern = new FakeJoern();
  joern.registerFails = true;
  const p = new TestPlugin();
  let ran = false;
  await captureLog(async () => {
    const { msg, done } = start(
      p,
      {
        middleware: use(namer(joern)),
        requestHandler: () => {
          ran = true;
        },
      },
      { body: {} },
    );
    await done;
    assert.equal(msg.reply().error, "joern refused the query");
    assert.equal(msg.reply().jobId, undefined);
  });
  assert.equal(ran, false);
  assert.equal(p.sent.length, 0);
});

test("an id too short for the runtime is refused before accept, and compensated", async () => {
  const joern = new FakeJoern();
  joern.idPrefix = "q7"; // "q7-1" — under fractal-core's 10-character floor
  const p = new TestPlugin();
  await captureLog(async () => {
    const { msg, done } = start(p, { middleware: use(namer(joern)) }, { body: {} });
    await done;
    assert.match(msg.reply().error ?? "", /shorter than 10 characters/);
  });
  assert.deepEqual(joern.aborted, ["q7-1"], "what was registered was un-registered");
  assert.equal(joern.live.size, 0);
});

test("a rejection after registration runs the onDone compensation", async () => {
  const joern = new FakeJoern();
  const p = new TestPlugin();
  await captureLog(async () => {
    const { done } = start(
      p,
      {
        middleware: use(
          (ctx, job) => {
            const next = namer(joern)(ctx, job);
            const id = joern.live.values().next().value as string;
            // The job's context ends on rejection too, so the undo needs no
            // special casing for "a later function said no".
            next.onDone(() => joern.cancel(id));
            return next;
          },
          () => {
            throw new Error("the input failed validation");
          },
        ),
      },
      { body: {} },
    );
    await done;
  });
  await tick();
  assert.equal(joern.aborted.length, 1, "the query registered by the first function was dropped");
  assert.equal(joern.live.size, 0);
});

// ---- work observed across runs (detached-work) ----------------------------

test("the registry handle is adopted at the accept stage", async () => {
  const joern = new FakeJoern();
  const previous = joern.register(); // what last run started, still running
  const p = new TestPlugin();
  const { msg, done } = start(
    p,
    {
      middleware: use(namer(joern)),
      requestHandler: async (job: Job) => {
        await job.done({ state: "running" }, "joern");
      },
    },
    { _registry: { jobId: previous, reqAt: 1782773000 }, body: {} },
  );
  await done;
  assert.equal(msg.reply().jobId, previous, "it observes; it starts nothing");
  assert.equal(joern.live.size, 1);
});

test("no registry handle starts new work", async () => {
  const joern = new FakeJoern();
  const p = new TestPlugin();
  const { msg, done } = start(p, { middleware: use(namer(joern)) }, { _registry: {}, body: {} });
  await done;
  assert.equal(msg.reply().jobId, "q-8f21c47b3d-1");
  assert.equal(joern.live.size, 1);
});

test("a stale handle starts new work rather than observing a ghost", async () => {
  const joern = new FakeJoern();
  const p = new TestPlugin();
  const { msg, done } = start(
    p,
    { middleware: use(namer(joern)) },
    { _registry: { jobId: "q-forgotten-by-the-service" }, body: {} },
  );
  await done;
  assert.equal(msg.reply().jobId, "q-8f21c47b3d-1");
  assert.equal(joern.live.size, 1);
});

// ---- through the real start() wiring --------------------------------------

test("end to end through start(): the cpu subject runs the pipeline, the port stops it", async () => {
  const stops = new jobstop.Registry();
  const p = new TestPlugin();
  const conn = new MockConn();
  conn.attachTo(p);
  p.onSignal(chainSignals(stops.onSignal));

  let ctx!: JobContext;
  p.addAction({
    method: "act",
    middleware: use(stops.middleware),
    requestHandler: async (job: Job) => {
      ctx = job.context();
      if (!(await ctx.sleep(10_000))) return; // stopped: wind down without reporting
      await job.done({ ok: true });
    },
  });

  await captureLog(async () => {
    p.start();
    assert.ok(conn.subs.has("inflow.plugin.PID.>"), "the signal port is subscribed");

    const msg = new MockMsg(
      "inflow.cpu.PID.act",
      new TextEncoder().encode(JSON.stringify({ _registry: {}, body: {} })),
    );
    conn.deliver("inflow.cpu.PID.act", msg);
    await tick();
    const jobId = msg.reply().jobId!;
    assert.equal(stops.size, 1);

    const sig = new MockMsg(
      "inflow.plugin.PID.proc",
      new TextEncoder().encode(JSON.stringify({ conclusion: "flow_stop_by_user", jobId })),
    );
    conn.deliver("inflow.plugin.PID.>", sig);
    await tick();

    assert.equal(ctx.cause, jobstop.ErrStopped);
    assert.deepEqual(p.sent, [], "a stopped job reported nothing");
    assert.equal(stops.size, 0);
  });
});

test("an action with no middleware still works unchanged", async () => {
  // Backward compatibility: a plugin written before middleware existed gets a
  // uuid jobId, a usable context, and the same handshake.
  const p = new TestPlugin();
  const conn = new MockConn();
  conn.attachTo(p);
  const seen: { jobId?: string; canceled?: boolean } = {};
  p.addAction({
    method: "plain",
    requestHandler: async (job: Job) => {
      seen.jobId = job.jobId;
      seen.canceled = job.context().canceled;
      await job.done({ ok: true });
    },
  });

  await captureLog(async () => {
    p.start();
    const msg = new MockMsg(
      "inflow.cpu.PID.plain",
      new TextEncoder().encode(JSON.stringify({ _registry: {}, body: {} })),
    );
    conn.deliver("inflow.cpu.PID.plain", msg);
    await tick();
    assert.match(seen.jobId!, /^[0-9a-f-]{36}$/);
    assert.equal(seen.canceled, false);
    assert.equal(msg.reply().jobId, seen.jobId);
    assert.equal(p.sent[0]!.subject, `inflow.cpu.PID.${seen.jobId}.progress`);
  });
});

test("no onSignal logs the port note and subscribes nothing", async () => {
  const stops = new jobstop.Registry();
  const p = new TestPlugin();
  const conn = new MockConn();
  conn.attachTo(p);
  p.addAction({ method: "act", middleware: use(stops.middleware), requestHandler: () => {} });
  const lines = await captureLog(() => p.start());
  assert.ok(
    lines.some(
      (l) =>
        l.includes("Signals not subscribed on : inflow.plugin.PID.>") &&
        l.includes("actions with middleware: act"),
    ),
    lines.join("\n"),
  );
  assert.equal(conn.subs.has("inflow.plugin.PID.>"), false);
});

test("an action with no requestHandler is rejected, not left hanging", async () => {
  const p = new TestPlugin();
  const conn = new MockConn();
  conn.attachTo(p);
  // Cast: the type demands a handler, but a JS consumer can omit it.
  p.addAction({ method: "broken" } as unknown as Action);
  await captureLog(async () => {
    p.start();
    const msg = new MockMsg("inflow.cpu.PID.broken");
    conn.deliver("inflow.cpu.PID.broken", msg);
    await tick();
    assert.equal(msg.reply().error, "action not implemented");
  });
});
