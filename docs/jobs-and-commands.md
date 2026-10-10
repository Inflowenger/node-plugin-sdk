# Jobs & commands

Everything a plugin *does* happens inside a `Job`. When the runtime executes one of
your actions, the SDK acknowledges the request with a fresh `jobId` and hands your
`requestHandler` a `Job` bound to that id and to the NATS connection. Through it you
report progress, read/write the flow's context, route outbound branches, call
downstream services, and finish the job.

```ts
class Job {
  readonly action: string;  // the action method invoked
  readonly jobId: string;   // uuid correlating all commands for this execution
  readonly req: Request;    // the raw request (data, header, plugin)
}
```

Each method publishes to `inflow.cpu.<PLUGIN_ID>.<JOB_ID>.<command>` and returns the
runtime's reply as a `Uint8Array`. **All Job methods are async — `await` them.**

## Reading the request

`job.req.data` is the raw JSON body (a `Uint8Array`). Decode it with `castRequestTo`,
which unwraps the `{ _registry, body }` envelope:

```ts
let req;
try {
  req = castRequestTo<MyInput>(job.req.data);
} catch (e) {
  await job.doneWithError(String(e));
  return;
}
// req.body      -> MyInput
// req._registry -> Record<string, unknown>

if (req._registry?.jobId) {
  const doneAt = new Date(Number(req._registry.doneAt) * 1000);
  console.log(`previous run ${req._registry.jobId} finished at ${doneAt}`);
}
```

`job.req.header` exposes the NATS message headers (`MsgHdrs`) if you need transport
metadata.

## Progress

```ts
await job.progress(10, { title: "init step", content: "task is starting" });
await job.progress(50, { title: "working", content: "halfway there" });
```

Progress is advisory feedback; only reaching 100 (via `done`/`doneWithError`)
completes the job.

## Finishing a job

```ts
// Success — commits `data` as this node's output. Progress becomes 100.
await job.done({ status: "ok", body: result });

// Success, committing on an explicit key path (segments joined by ".")
await job.done(payload, "result", "http");

// Failure — reports the reason on the command's own `error` field, no details.
await job.doneWithError("upstream returned 500");

// Failure that still carries state — `data` is reported (and committed, at the
// optional key) alongside the reason.
await job.doneWithErrorData("rate limited", { cursor, conversation }, "state");

// Failure carrying the plugin's own error number too.
await job.doneWithErrorCode(429, "upstream rate limited", null);
```

All are a `progress` command at `100`: `done` sends `{progress:100, details:data,
commit_on:key}`, and the error variants add `error:{code,message}` with `details`
and `commit_on` filled exactly as `done` fills them.

The reason travels on that `error` field, **not** as a detail. So nothing in `data`
is reserved (a key named `error` is the plugin's to use), and the presence of the
field — not its contents — is what makes the finished job a failed one: an empty
message still fails the job. `code` is the plugin's own number in the plugin's own
numbering; the core carries it next to the message without interpreting it, so pass
`0` when the plugin has none.

A terminal command's details **are** what gets committed onto the node's scope, and
a bare `doneWithError` sends none, so it drops anything the node had persisted there
— hand it back through `doneWithErrorData` to keep it. Call exactly one before the
handler returns.

## Reading the flow context

```ts
// whole current scope (raw bytes — usually JSON)
const cur = await job.cmdGetCurrentScope();
console.log("current scope:", new TextDecoder().decode(cur));

// a slice addressed by JSON path
const scope = await job.cmdGetScope("$.OPA");
console.log("$.OPA =", new TextDecoder().decode(scope));
```

Both resolve to a `Uint8Array` of the runtime's reply — decode with a `TextDecoder`.

## Writing to the flow context (context injection)

```ts
await job.cmdSetOnPath(`$["doc appendix"]`, { itemXterm: [1, 3, 42, 2300] });
```

The path is a JSON path into the context tree; the object is the value written there.
This is a `commit` command carrying `{commit_on: path, details: data}`. This is how a
plugin **injects** results that downstream nodes read — distinct from `job.done`,
which emits the node's own output.

## Routing outbound branches

An action can declare `outbound` ports (see [form-builder.md](form-builder.md) /
`Action.outbound`); at runtime the handler chooses which branch(es) fire by naming
their tags. Edges carrying other tags are skipped.

```ts
await job.cmdNextFilter(["approved"]);      // fire only the "approved" branch
```

## Plugin-originated service calls

A handler can call a downstream service itself, mid-job, rather than only emitting
its result at the end:

```ts
const reply = await job.cmdSvcCall("some.service", { q: "term" }, { op: "search" });
console.log(new TextDecoder().decode(reply));
```

`action` names the service, the second argument is the payload, the third is
optional operation metadata (sent as `op`). It publishes to
`inflow.cpu.<PLUGIN_ID>.<JOB_ID>.request/svc.<action>`.

## Signals — when the runtime ends a process

Everything above is the job talking *to* the runtime. The signal port is the one
channel that runs the other way: the runtime publishes on
`inflow.plugin.<PLUGIN_ID>.proc` the moment it stops attending a plugin node process,
saying which job ended and how.

```ts
p.onSignal((sig) => {
  if (sig.kind !== PluginSignal.Proc) return;
  console.log(`job ${sig.jobId} ended: ${sig.conclusion}`);
});
```

Register it **before `start()`** — `start()` does the subscribing. `p.onSignal()`
with no argument installs a handler that just logs the port, handy while developing.

Registering a handler of your own replaces that logging — the port goes quiet just
as the plugin starts acting on it. `logSignals("<plugin>")` is that same line as a
handler you can keep beside your own:

```ts
p.onSignal(chainSignals(logSignals("ai-decision"), stops.onSignal));
// ai-decision: signal proc job=<uuid> conclusion=flow_stop_by_user canceled=true succeeded=false
// jobstop: job <uuid> cancelled: the runtime concluded its process flow_stop_by_user
```

Two lines, because they are two events: the signal **arriving**, and a job of this
process being **cut short** by it — the second comes from
`jobstop.Registry.onSignal`, which logs only the jobs it holds. One subject carries
every signal of the plugin, so the first line also appears for jobs of other flows,
and of other replicas, that this process never accepted; those get no second line.

```ts
interface Signal {
  kind: PluginSignal | string; // "proc" — the subject past inflow.plugin.<PLUGIN_ID>.
  subject: string;
  jobId: string;               // the job this is about: the same id as job.jobId
  conclusion: Conclusion | string;
  data: Uint8Array;            // raw payload, for kinds this SDK does not model
  msg: Msg;                    // escape hatch; a signal is a publish — never respond
}
```

`Conclusion` lists every verdict (see
[protocol-inflowv1.md](protocol-inflowv1.md#inflowplugin--signal-port-one-way-optional)),
and two helpers read it:

| Helper | True for |
|--------|----------|
| `succeeded(sig.conclusion)` | `done`, `next` — the job ended the way it intended. |
| `canceled(sig.conclusion)`  | `flow_stop_by_user`, `stop_command`, `timeout`, `long_time_without_command` — something outside the job cut it short. |

### Why this is optional, and why stopping is not the default

**A stopped process does not mean a stopped job.** When a user cancels a flow or a
workflow times out, the work the plugin took on deliberately keeps running. A later
process on the same node may rely on the progress this one made: the runtime hands
the previous `jobId` back in `_registry`, so a half-built export, an open import
cursor or a warmed cache is an asset, not garbage.

So the SDK does nothing about `proc` signals unless you ask. A plugin that never
calls `onSignal` behaves exactly as it always has — **nothing breaks by ignoring
this**. Register a handler only for work that genuinely must not outlive the process:
a stream to close, an upstream request to abort, a lock or reservation to release.

File cancellable work under its `jobId` and let the signal find it — and file it
*before the runtime knows the jobId*, which is what middleware is for.

### Middleware — functions run before the job is accepted

Every action request runs a list of **middleware functions**, in order, before the
job is accepted:

```ts
type MiddlewareFunc = (
  ctx: JobContext,
  job: Job,
) => JobContext | void | Promise<JobContext | void>;
```

```
request ─▶ jobID ─▶ plugin's (p.use) ─▶ action's (Action.middleware) ─▶ accept: reply jobId ─▶ handler
```

A plain array is the list; `use(...)` builds one while dropping empty slots:

```ts
p.use(trace);                                  // every action
p.addAction({
  method: "run",
  middleware: [stops.middleware, register],    // this action, in this order
  requestHandler,
});
```

- **`jobID`** runs first: it binds a fresh jobId (a UUID) to the context —
  `jobIDFromContext(ctx)` reads it — and the SDK sets `job.jobId` from it, so every
  function after it sees the job named. It is a function like any other:
  `withJobID(fn)` (a `newPlugin` option) replaces it for a plugin that names its jobs
  its own way. A function later in the chain may rename the job too — the SDK keeps
  `job.jobId` in step with the context after *every* function — which is how a plugin
  runs a job under an id its upstream service minted: see
  [external-job-identity.md](external-job-identity.md).
- Each function gets the context the one before it returned, and returns it — with
  whatever it bound — for the next; the last one's is the handler's `job.context()`.
  Returning nothing keeps the context it was given, so a function with only a side
  effect needs no return.
- Then the job is **accepted** — the jobId replied to the runtime — and the handler
  runs.

Because they run before the reply, the runtime does not know the jobId while they
run: nothing can happen to the job — a stop, a query from a later run — before what a
function set up under that jobId is in place.

```ts
function register(ctx: JobContext, job: Job) {
  runs.set(job.jobId, { status: "running" }); // before the runtime knows the jobId
  return ctx;
}
```

- **A throw rejects the request**: the runtime gets the error instead of a jobId, and
  neither the functions after it nor the handler run. A rejected promise from an
  `async` function is the same thing. (This is what Go gets from an `error` return
  plus panic recovery.)
- **The job's context ends when the handler returns** (like an `http.Request`'s), or
  when the request is rejected. A function that must clean up when the job ends does
  it with `ctx.onDone(cleanup)`.
- A function may be `async` and the SDK awaits it, but the runtime gives up on a
  jobId it waits too long for (15s), so keep it quick. One request's middleware never
  holds up another's: each request runs its pipeline on its own.

### `JobContext` — the job's cancellation and value scope

`job.context()` is the context the middleware passed down. It is the Node
counterpart of Go's `context.Context`, built on `AbortSignal`:

| What you want | Call |
|---|---|
| Hand cancellation to `fetch`, a stream, any abortable API | `ctx.signal` |
| Ask whether the job has been cut short | `ctx.canceled` |
| Ask *why* it ended | `ctx.cause` (e.g. `jobstop.ErrStopped`) |
| Wait, or stop waiting when the job ends | `await ctx.sleep(ms)` → `false` if it ended |
| Run cleanup when the job ends, however it ends | `ctx.onDone((cause) => …)` |
| Carry a value down the chain | `ctx.withValue(key, v)` / `ctx.value(key)` |
| Keep work alive past the handler | `ctx.withoutCancel()` |
| Put a deadline on one step | `const [c, cancel] = ctx.withTimeout(5_000)` |

A job from an action with no middleware answers a background context — never
cancelled — so a handler may read `ctx.canceled` unconditionally.

The SDK adds no capability to a job on its own. Each one is a middleware function you
list where it is needed — and, if it reacts to how processes end, a signal handler:

| Capability | Middleware function | Signal port |
|------------|---------------------|-------------|
| Stop with the flow | `stops.middleware` | `stops.onSignal` |
| A long-running job kept for a later run | yours, filing the jobId in your own map | yours, if it reacts to endings |
| Tracing | yours: start a span, end it with `ctx.onDone` | — |
| [An external service's job id as the jobId](external-job-identity.md) | yours: register upstream, bind the id with `withJobIDContext` | yours: abort upstream by `sig.jobId` |

The port keeps one handler: `chainSignals(h1, h2, …)` composes several into one.

### Stopping a job with its flow — `jobstop`

`jobstop` is the stop capability, built from the two pieces above:

```ts
import { jobstop, type Job } from "@inflowenger/node-plugin-sdk";

const stops = new jobstop.Registry(); // one per plugin

p.onSignal(stops.onSignal); // before start() — without it, no stop ever arrives
p.addAction({
  method: "long.export",
  middleware: [stops.middleware],
  requestHandler: exportHandler,
});

async function exportHandler(job: Job) {
  const ctx = job.context();
  try {
    const res = await fetch(url, { signal: ctx.signal }); // aborts with the flow
    await job.done({ ok: res.ok });
  } catch (err) {
    if (ctx.canceled) return; // stopped by the runtime: nobody is listening
    await job.doneWithError(String(err));
  }
}
```

`stops.middleware` files the job under its jobId before it is accepted, and unfiles
it when its context ends; `stops.onSignal` cancels it when the runtime concludes its
process as `canceled()` (cause `jobstop.ErrStopped`) and unfiles it on any other
ending. `stops.cancelAll()` cancels every job it holds (cause
`jobstop.ErrShutdown`), for a plugin about to exit; it sends nothing to the runtime.
Without `p.onSignal(stops.onSignal)` the signal port is not subscribed — `start()`
logs `Signals not subscribed on …` — and no stop arrives.

**Isolation is by `jobId`, and it has to be.** The runtime publishes every process
signal of a plugin on one subject, `inflow.plugin.<PLUGIN_ID>.proc`, so every process
of that plugin hears all of them: the endings of jobs in other flows running at the
same time, and — when the plugin runs as several replicas — of jobs this process never
accepted. The payload carries no flowId; the `jobId` is the only discriminator on the
wire. A stop for a job the registry does not hold does nothing.

Three things to keep in mind:

- **Signals arrive for every ending, including `done`.** `stops.onSignal` cancels on
  `canceled()` only; a hand-written handler should filter on `conclusion` the same
  way.
- **The runtime is already gone.** By the time a stop cancels `ctx`, that job's
  command subjects have no responder: a `progress` or `done` from the stopped handler
  retries and fails, slowly. Check `ctx.canceled` and return — not the error a library
  returned, which may not say it was cancelled.
- **An abort usually surfaces as a throw.** `fetch` on an aborted signal rejects with
  an `AbortError`, which would otherwise unwind out of the handler and be reported as
  a failed job. The SDK guards that last step — a handler that throws while its
  context is already cancelled reports nothing and logs instead — but catch it
  yourself where the handler has cleanup to do. (Go has no equivalent of this guard,
  because there a cancellation is a returned error the handler inspects.)

Handlers are invoked without being awaited (so a slow one does not stall the port)
and a rejection inside one is caught and logged. Only the last registered handler is
kept.

### Beyond stopping: work that outlives the process

Two patterns build on the pieces above, and both start from the same place — a
middleware function that decides what the job *is* before the runtime is told:

#### One id across two systems

The pieces above compose into something larger than cancellation. A plugin that
fronts a service with its own job ids — a Joern server, a render farm — can **adopt
that id as the jobId** in a middleware function, so the runtime, the plugin and the
service all name the work the same way: no correlation map, a stop that any replica
can forward upstream, and a re-run that reattaches to the previous run's upstream work
through `_registry`. That pattern, its invariants and its failure modes are
[external-job-identity.md](external-job-identity.md).

#### The flow as an observer

Work measured in hours fits in no job: the runtime waits 15s for a `jobId`, gives up
on a job that goes quiet for the node's `idle_min`, and ends the run at
`ExecuteTimeOut`. So a plugin can decline to wait — report *where the work has got
to*, route a "not yet" port with `cmdNextFilter`, and `done` in seconds. The flow's
process finishes, the external work does not, and a later run of the same node reads
`_registry.jobId`, finds the work still running and reports again — until the run that
finds it finished commits the result and routes the ready branch. Asynchrony stays
inside the plugin, where the knowledge is; the graph needs no node type for it. See
[detached-work.md](detached-work.md).

## Command reference

| Method | Command subject suffix | Payload → | Resolves to |
|--------|------------------------|-----------|-------------|
| `progress(pct, frame)`      | `progress`        | `{progress, frame}` | ack bytes |
| `done(data, ...key)`        | `progress`        | `{progress:100, details, commit_on}` | ack bytes |
| `doneWithError(msg)`        | `progress`        | `{progress:100, error:{message}}` | ack bytes |
| `doneWithErrorData(msg, data, ...key)` | `progress` | `{progress:100, details, commit_on, error:{message}}` | ack bytes |
| `doneWithErrorCode(code, msg, data, ...key)` | `progress` | `{progress:100, details, commit_on, error:{code,message}}` | ack bytes |
| `cmdGetCurrentScope()`      | `context/current` | — | context bytes |
| `cmdGetScope(jsonPath)`     | `context/path`    | `jsonPath` | context bytes |
| `cmdSetOnPath(jsonPath, o)` | `commit`          | `{commit_on, details}` | ack bytes |
| `cmdNextFilter(tags)`       | `next_tags`       | `tags.join(",")` | ack bytes |
| `cmdSvcCall(action, data, op)` | `request/svc.<action>` | `{data, op}` | reply bytes |

## A complete handler

```ts
p.addAction({
  method: "fn",
  requestHandler: async (job: Job) => {
    // read context
    console.log("current:", new TextDecoder().decode(await job.cmdGetCurrentScope()));
    console.log("$.OPA:", new TextDecoder().decode(await job.cmdGetScope("$.OPA")));

    // write context
    await job.cmdSetOnPath(`$["doc appendix"]`, { itemXterm: [1, 3, 42, 2300] });

    // finish
    await job.done({ action: "done finally...." });
  },
});
```
