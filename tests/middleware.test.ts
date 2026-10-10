// The request pipeline: middleware order, naming, rejection, the job's context.
// The Node counterpart of sdkv1/middleware_test.go.
import assert from "node:assert/strict";
import test from "node:test";
import {
  background,
  chainSignals,
  jobID,
  jobIDFromContext,
  logSignals,
  runPipeline,
  signalPortNote,
  use,
  withJobIDContext,
  type Action,
  type JobContext,
  type Job,
  type MiddlewareFunc,
  type Signal,
} from "../src/index.js";
import { captureLog, deferred, MockMsg, TestPlugin, tick } from "./harness.js";

/** Run one request of `action` through p's pipeline, to the end. */
async function runOne(
  p: TestPlugin,
  action: Partial<Action>,
  body?: unknown,
): Promise<MockMsg> {
  const msg = new MockMsg(
    "inflow.cpu.PID.run",
    body === undefined ? new Uint8Array() : new TextEncoder().encode(JSON.stringify(body)),
  );
  const full: Action = {
    method: action.method ?? "run",
    requestHandler: action.requestHandler ?? (() => {}),
    middleware: action.middleware,
  };
  await runPipeline(p, full, { data: msg.data, plugin: p }, msg.msg);
  return msg;
}

const noop = () => {};

test("middleware runs in order, after the namer", async () => {
  const p = new TestPlugin();
  const order: string[] = [];
  const mark = (name: string): MiddlewareFunc => (ctx) => {
    order.push(name);
    return ctx;
  };
  p.use(mark("plugin-1"), mark("plugin-2"));
  await runOne(p, {
    middleware: use(mark("action-1"), mark("action-2")),
    requestHandler: () => {
      order.push("handler");
    },
  });
  assert.deepEqual(order, ["plugin-1", "plugin-2", "action-1", "action-2", "handler"]);
});

test("use skips empty slots and keeps order", () => {
  const a: MiddlewareFunc = (c) => c;
  const b: MiddlewareFunc = (c) => c;
  assert.deepEqual(use(a, undefined, b, null), [a, b]);
  assert.deepEqual(use(), []);
});

test("jobID names the job before any other function sees it", async () => {
  const p = new TestPlugin();
  let seen = "";
  let fromCtx = "";
  const msg = await runOne(p, {
    middleware: use((ctx, job) => {
      seen = job.jobId;
      fromCtx = jobIDFromContext(ctx);
      return ctx;
    }),
  });
  assert.match(seen, /^[0-9a-f-]{36}$/);
  assert.equal(fromCtx, seen);
  assert.equal(msg.reply().jobId, seen, "the accepted jobId is the one middleware saw");
});

test("jobID is fresh per request", async () => {
  const p = new TestPlugin();
  const ids = new Set<string>();
  for (let i = 0; i < 3; i++) {
    const msg = await runOne(p, {});
    ids.add(msg.reply().jobId!);
  }
  assert.equal(ids.size, 3);
});

test("a later function may rename the job, and the SDK keeps up", async () => {
  const p = new TestPlugin();
  let handlerSaw = "";
  const msg = await runOne(p, {
    middleware: use(
      (ctx) => withJobIDContext(ctx, "upstream-12345"),
      (ctx, job) => {
        assert.equal(job.jobId, "upstream-12345", "the next function sees the new name");
        return ctx;
      },
    ),
    requestHandler: (job: Job) => {
      handlerSaw = job.jobId;
    },
  });
  assert.equal(msg.reply().jobId, "upstream-12345");
  assert.equal(handlerSaw, "upstream-12345");
});

test("withJobID replaces the namer", async () => {
  const p = new TestPlugin();
  p.jobIDFn = (ctx) => withJobIDContext(ctx, "named-by-plugin");
  const msg = await runOne(p, {});
  assert.equal(msg.reply().jobId, "named-by-plugin");
});

test("a nameless job is rejected, not accepted as \"\"", async () => {
  const p = new TestPlugin();
  p.jobIDFn = (ctx) => ctx; // binds nothing
  let ran = false;
  const msg = await captureLog(async () => {
    const m = await runOne(p, { requestHandler: () => { ran = true; } });
    assert.match(m.reply().error ?? "", /no jobId/);
  });
  assert.equal(ran, false);
  assert.ok(msg.some((l) => l.includes("rejected")));
});

test("the context flows to the handler and ends when it returns", async () => {
  const p = new TestPlugin();
  const key = Symbol("k");
  let handlerCtx: JobContext | undefined;
  let endedWhileRunning = true;
  await runOne(p, {
    middleware: use((ctx) => ctx.withValue(key, "bound")),
    requestHandler: (job: Job) => {
      handlerCtx = job.context();
      assert.equal(handlerCtx.value(key), "bound");
      endedWhileRunning = handlerCtx.canceled;
    },
  });
  assert.equal(endedWhileRunning, false, "live while the handler runs");
  assert.equal(handlerCtx!.canceled, true, "ended once it returned");
});

test("onDone fires when the job's context ends", async () => {
  const p = new TestPlugin();
  const causes: unknown[] = [];
  await runOne(p, {
    middleware: use((ctx) => {
      ctx.onDone((cause) => causes.push(cause));
      return ctx;
    }),
  });
  await tick();
  assert.equal(causes.length, 1);
});

test("job.context() is the background context for a job built by hand", async () => {
  const p = new TestPlugin();
  let ctx: JobContext | undefined;
  await runOne(p, {
    requestHandler: (job: Job) => {
      ctx = job.context();
      const narrowed = job.withContext(background().withValue("k", 1));
      assert.equal(narrowed.context().value("k"), 1);
      assert.equal(narrowed.jobId, job.jobId);
    },
  });
  assert.equal(ctx!.canceled, true);
});

test("a middleware error rejects the request and the handler never runs", async () => {
  const p = new TestPlugin();
  let ran = false;
  let laterRan = false;
  await captureLog(async () => {
    const msg = await runOne(p, {
      middleware: use(
        () => {
          throw new Error("joern refused the query");
        },
        (ctx) => {
          laterRan = true;
          return ctx;
        },
      ),
      requestHandler: () => {
        ran = true;
      },
    });
    assert.equal(msg.reply().error, "joern refused the query");
  });
  assert.equal(ran, false);
  assert.equal(laterRan, false);
  assert.equal(p.sent.length, 0, "a rejected request sends no command");
});

test("a rejected async middleware is the same as a thrown one", async () => {
  const p = new TestPlugin();
  await captureLog(async () => {
    const msg = await runOne(p, {
      middleware: use(async () => {
        await tick();
        throw new Error("upstream down");
      }),
    });
    assert.equal(msg.reply().error, "upstream down");
  });
});

test("a handler error is reported to the runtime as a failure", async () => {
  const p = new TestPlugin();
  await runOne(p, {
    requestHandler: () => {
      throw new Error("boom");
    },
  });
  assert.equal(p.sent.length, 1);
  assert.match(p.sent[0]!.subject, /\.progress$/);
  const body = JSON.parse(p.sent[0]!.body) as { error?: { message: string } };
  assert.equal(body.error?.message, "boom");
});

test("dispatch does not wait for one request's middleware", async () => {
  const p = new TestPlugin();
  const gate = deferred();
  const started: string[] = [];
  const action: Action = {
    method: "run",
    middleware: use(async (ctx, job) => {
      started.push(job.jobId);
      await gate.promise;
      return ctx;
    }),
    requestHandler: noop,
  };
  const first = new MockMsg();
  const second = new MockMsg();
  const a = runPipeline(p, action, { data: first.data, plugin: p }, first.msg);
  const b = runPipeline(p, action, { data: second.data, plugin: p }, second.msg);
  await tick();
  assert.equal(started.length, 2, "the second request started while the first was blocked");
  assert.equal(first.replies.length, 0, "neither is accepted yet");
  gate.resolve();
  await Promise.all([a, b]);
  assert.ok(first.reply().jobId);
  assert.ok(second.reply().jobId);
});

test("chainSignals gives every handler every signal, in order", async () => {
  const seen: string[] = [];
  const chained = chainSignals(
    () => {
      seen.push("first");
    },
    () => {
      throw new Error("handler blew up");
    },
    () => {
      seen.push("third");
    },
    undefined,
  );
  await captureLog(async () => {
    await chained({ kind: "proc", subject: "inflow.plugin.PID.proc", jobId: "j", conclusion: "done", data: new Uint8Array() } as Signal);
  });
  assert.deepEqual(seen, ["first", "third"], "a throw does not stop the handlers after it");
});

test("logSignals prints one line per signal", async () => {
  const lines = await captureLog(() => {
    const log = logSignals("ai-decision");
    log({
      kind: "proc",
      subject: "inflow.plugin.PID.proc",
      jobId: "job-1",
      conclusion: "flow_stop_by_user",
      data: new Uint8Array(),
    } as Signal);
    log({
      kind: "future",
      subject: "inflow.plugin.PID.future",
      jobId: "",
      conclusion: "",
      data: new TextEncoder().encode(`{"x":1}`),
    } as Signal);
  });
  assert.match(lines[0]!, /^ai-decision: signal proc job=job-1 conclusion=flow_stop_by_user canceled=true succeeded=false$/);
  assert.match(lines[1]!, /signal future subject=inflow\.plugin\.PID\.future data=\{"x":1\}/);
});

test("the port note names the actions whose middleware will never fire", () => {
  const p = new TestPlugin();
  p.addAction({ method: "run", middleware: use(jobID), requestHandler: noop });
  p.addAction({ method: "plain", requestHandler: noop });
  const note = signalPortNote(p);
  assert.match(note, /Signals not subscribed on : inflow\.plugin\.PID\.>/);
  assert.match(note, /actions with middleware: run$/);
  assert.ok(!note.includes("plain"));
});
