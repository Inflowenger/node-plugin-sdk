# One job, one id — adopting an external service's job id

> Advanced pattern. It needs [§ Middleware](jobs-and-commands.md#middleware--functions-run-before-the-job-is-accepted),
> [§ Signals](jobs-and-commands.md#signals--when-the-runtime-ends-a-process) and
> [§ `jobstop`](jobs-and-commands.md#stopping-a-job-with-its-flow--jobstop) first.

A great many plugins are **middlemen**. The node on the canvas does no work itself:
it registers work with a service that has its own API, its own queue and its own
lifetime — Joern's HTTP server for code-property-graph queries, a rendering farm, a
training job, a long-running scan — and then reports back.

Those services almost always **name the work themselves**. You `POST /query` and
Joern answers `{"queryId": "q-8f21c47b3d"}`. Everything afterwards — polling, logs,
cancelling, the service's own dashboard — is addressed by that id.

The runtime names work too. A plugin job is identified by the `jobId` the SDK replies
in the request→job handshake, and every command the job sends travels on
`inflow.cpu.<PLUGIN_ID>.<JOB_ID>.<command>`.

So the naive middleman holds **two names for one piece of work** and a map between
them. This document is about not doing that: about running the job under the
service's own id, which the SDK's middleware makes a three-line change, and about
what that buys — one correlation id end to end, cancellation that reaches the service,
and resumability across runs. It is, in effect, a distributed transaction over two
systems that share nothing but a name.

---

## 1. The cost of two id spaces

Here is the middleman everyone writes first:

```ts
const upstream = new Map<string, string>(); // plugin jobId -> joern queryId  ← the thing to delete

async function queryHandler(job: Job) {
  let queryId: string;
  try {
    queryId = await joern.register(project, query);
  } catch (err) {
    await job.doneWithError(String(err));
    return;
  }
  upstream.set(job.jobId, queryId);
  try {
    // ... poll queryId, report under job.jobId ...
  } finally {
    upstream.delete(job.jobId);
  }
}

p.onSignal((sig) => {
  const queryId = upstream.get(sig.jobId);
  if (queryId && canceled(sig.conclusion)) void joern.cancel(queryId); // best effort
});
```

It works, until it doesn't. The map is the weak link in five separate ways:

| Problem | Why the map causes it |
|---|---|
| **A window with no mapping** | The job is accepted — the runtime knows the `jobId` and may stop it at any moment — before `register` has returned. A stop arriving in that window finds nothing to cancel, and the query runs on in Joern with nobody watching it. |
| **It dies with the process** | The map is process memory. A redeploy, a crash or an OOM kill between register and done loses every correlation; the queries stay alive upstream and become unattributable garbage. |
| **It is not where the signal is** | Process signals are broadcast to **every** process of the plugin (`inflow.plugin.<PLUGIN_ID>.proc`). The replica that hears the stop is usually not the replica holding the map entry, so the abort never leaves. |
| **Nobody can join the two sides** | The canvas, the flow's context and the logs show `jobId`; Joern's dashboard and its logs show `queryId`. Debugging a slow query means a human joining two id spaces by timestamp. |
| **Resume is impossible** | The runtime hands the previous run's `jobId` back in `_registry`. With a map that has since died, the previous `jobId` resolves to nothing, so a re-run starts a *second* Joern query instead of reattaching to the first. |

Every one of these is a symptom of the same thing: the identity of the work was
decided twice, independently, in two places.

---

## 2. The mechanism: name the job before it is accepted

The SDK does not mint a `jobId` behind your back. It mints one in a **middleware
function** — `jobID`, the first function of every request's pipeline — and middleware
runs *before* the job is accepted:

```
request ─▶ jobID ─▶ p.use(...) ─▶ Action.middleware(...) ─▶ accept: reply jobId ─▶ handler
          └── mints a uuid ──┘   └── any of these may rename the job ──┘
```

After **each** function, the SDK re-reads the id bound to the context and keeps
`job.jobId` in step with it ([`inflowV1.ts`](../src/inflowV1.ts), `runMiddleware`).
So any function in the chain can name the job, and the last one to do so wins:

```ts
async function registerQuery(ctx: JobContext, job: Job) {
  const queryId = await joern.register(project, query); // a throw rejects the request
  return withJobIDContext(ctx, queryId);                // ← the job is now "q-8f21c47b3d"
}
```

```ts
middleware: [registerQuery, stops.middleware],
```

That is the whole mechanism. From the moment the pipeline ends, `q-8f21c47b3d` is not
a value the plugin remembers — it **is** the job, everywhere:

| Where | Carries the service's id |
|---|---|
| `job.jobId` in the handler | `q-8f21c47b3d` |
| `jobIDFromContext(job.context())` | `q-8f21c47b3d` — for a logger or tracer deep in the call chain |
| Every command subject | `inflow.cpu.joern-plugin.q-8f21c47b3d.progress` |
| The handshake reply to the runtime | `{"jobId":"q-8f21c47b3d"}` — the canvas, the flow's record |
| The stop signal's payload | `sig.jobId === "q-8f21c47b3d"` |
| The next run's `_registry.jobId` | `q-8f21c47b3d` |

Two id spaces became one. The `Map` is deleted, not improved.

> **Plugin-wide alternative.** `withJobID(fn)`, an option to `newPlugin`, *replaces*
> `jobID` for every action of the plugin. Use it only when the plugin as a whole is a
> proxy for one service; use `Action.middleware` when some actions talk to the service
> and others (a settings test, a pure transform) do not.

---

## 3. The scenario: a Joern middleman, end to end

Joern runs as its own HTTP server. The plugin node is the only way an Inflowenger
flow reaches it.

```
  canvas / flow                 plugin process                    joern :8080
        │                                │                                 │
execute │─── inflow.v1.<id>.cpg.query ─▶ │                                 │
        │                                │─── POST /query ───────────────▶ │
        │                                │◀── 201 {queryId: q-8f21c47b3d}  │ ← the name
        │                                │                                 │
        │                                ├─ files q-8f21c47b3d (stops)     │
        │◀── {jobId: q-8f21c47b3d} ───── ┤  accept                         │
        │                                │                                 │
        │◀─ …q-8f21c47b3d.progress ───── ┤◀─ GET /query/q-8f21c47b3d ──▶   │
        │         (repeat)               │                                 │
        │                                │                                 │
  user  │                                │                                 │
stops ─ │── inflow.plugin.<id>.proc ───▶ │                                 │
        │   {jobId: q-8f21c47b3d,        ├─ ctx cancelled (ErrStopped)     │
        │    conclusion:                 │                                 │
        │     flow_stop_by_user}         └─ DELETE /query/q-8f21c47b3d ─▶  │ ← abort
        │                                │                                 │
```

Note what is *not* in that diagram: no lookup table, and no step in which one side
holds a name the other cannot resolve.

### The plugin

```ts
import {
  canceled,
  castRequestTo,
  chainSignals,
  jobstop,
  newPlugin,
  withDotEnv,
  withJobIDContext,
  type Job,
  type JobContext,
  type Signal,
} from "@inflowenger/node-plugin-sdk";

const joern = new Joern("http://joern:8080");
const stops = new jobstop.Registry();

interface QueryInput {
  project: string;
  query: string;
}

async function main() {
  const p = await newPlugin(withDotEnv(".env.inflow"));
  p.intro({ name: "JOERN.QUERY", author: "inflow Dev. Team", version: "v0.1.0" });

  // Two handlers on the one signal port: cancel the local work, and tell Joern.
  p.onSignal(chainSignals(stops.onSignal, abortUpstream));

  p.addAction({
    method: "cpg.query",
    title: "Run CPG query",
    description: "Register a CPG query on the Joern server and stream its result back",
    // Order matters: the job is named by the service FIRST, so everything after
    // it — stops' registry included — is keyed by the shared id.
    middleware: [registerQuery, stops.middleware],
    requestHandler: queryHandler,
  });

  p.start();
  await new Promise(() => {});
}
```

### The middleware: enlist, then name

```ts
/**
 * Enlist the work upstream and run the job under the id Joern gave it. It runs
 * before the job is accepted, so the id it binds is the id the runtime is told.
 */
async function registerQuery(ctx: JobContext, job: Job): Promise<JobContext> {
  const input = castRequestTo<QueryInput>(job.req.data); // throws ⇒ request rejected

  // Reattach to this node's previous run instead of starting a second query.
  const prev = input._registry?.jobId as string | undefined;
  if (prev && (await joern.alive(prev))) return withJobIDContext(ctx, prev);

  const queryId = await joern.register(input.body.project, input.body.query);
  const problem = unusableJobId(queryId);
  if (problem) {
    await joern.cancel(queryId); // never accepted: undo it
    throw new Error(problem);
  }
  return withJobIDContext(ctx, queryId);
}

/**
 * Why an id the runtime or the wire cannot carry is unusable, or "" if it is fine:
 * the job's command subjects are built from it, and fractal-core refuses an init
 * reply whose jobId is shorter than 10 characters (see § 6).
 */
function unusableJobId(id: string): string {
  if (id.length < 10) return `jobId ${id} from joern is shorter than 10 characters`;
  if (/[.\s*>]/.test(id)) return `jobId ${id} from joern is not a usable subject token`;
  return "";
}
```

Read the three exits in order, because they are the pattern's whole safety argument:

1. **Joern refuses** → a throw → the request is rejected. The runtime is told the
   reason instead of a `jobId`; the node never started; there is no upstream work and
   nothing to clean up.
2. **Joern accepts but the id is unusable** → compensate (`cancel`), then reject. We
   registered something, so we un-register it before giving up.
3. **Joern accepts** → bind the id. The job is accepted *after* this returns, so the
   runtime learns about the job only once the upstream work exists and is named.

### The handler: the id is already shared

```ts
async function queryHandler(job: Job) {
  const ctx = job.context();
  const queryId = job.jobId; // === the Joern queryId

  for (;;) {
    let status: Status;
    try {
      status = await joern.poll(queryId, ctx.signal);
    } catch (err) {
      // Stopped: the runtime has concluded this job and stopped listening. The
      // abort is the signal handler's business.
      if (ctx.canceled) return;
      await job.doneWithError(String(err));
      return;
    }
    if (status.done) {
      await job.done({ queryId, result: status.result }, "joern");
      return;
    }
    await job.progress(status.percent, { title: "Joern", content: status.stage });

    if (!(await ctx.sleep(2_000))) return; // false ⇒ the job was stopped
  }
}
```

The handler never translates an id, and the result it commits carries `queryId` —
which is `job.jobId` — into the flow's context, so a downstream node (or a human
reading the run) can address Joern directly.

---

## 4. Cancellation: making a stop cross the boundary

A stop is the moment the two systems must agree, and it is where the shared id pays
for itself twice.

When a user stops the flow, the runtime publishes on
`inflow.plugin.<PLUGIN_ID>.proc` with
`{"jobId":"q-8f21c47b3d","conclusion":"flow_stop_by_user"}` and stops attending the
node. Two different things now have to happen, and the plugin composes them on the
one port with `chainSignals`:

```ts
p.onSignal(chainSignals(stops.onSignal, abortUpstream));
```

**Local: stop doing the work.** `stops.onSignal` looks the job up by `sig.jobId` and
cancels its context with `jobstop.ErrStopped`. The handler's in-flight `fetch` aborts
(it was given `ctx.signal`), `ctx.canceled` is true, and it returns **without
reporting** — the runtime is already gone, so a `done` would retry against a subject
with no responder. (See
[§ `jobstop`](jobs-and-commands.md#stopping-a-job-with-its-flow--jobstop).)

This is exactly where the ordering rule comes from. `stops.middleware` files the job
under `job.jobId` *as it is when that function runs*. Put it before the namer and it
files a uuid, while the id on the wire is `q-8f21c47b3d` — the stop arrives, matches
nothing, and is silently lost. There is a test for that mistake, so the rule is not
folklore: [`tests/jobstop.test.ts`](../tests/jobstop.test.ts), *"filing before the
namer misses the stop"*.

> **Rule.** The function that names the job comes first. Anything keyed on the
> `jobId` — `stops.middleware`, your own registry, a span — comes after it.

**Remote: tell Joern.** Because the id on the signal *is* the Joern queryId, the
notification needs no local state at all:

```ts
/**
 * Tell Joern to drop the query when the runtime stops the flow. It needs no local
 * state: the signal already names the query.
 */
async function abortUpstream(sig: Signal) {
  if (sig.kind !== PluginSignal.Proc || !canceled(sig.conclusion)) return;
  const [ctx, cancel] = background().withTimeout(5_000);
  try {
    await joern.cancel(sig.jobId, ctx.signal);
  } catch (err) {
    console.log(`joern: could not abort ${sig.jobId}:`, err);
  } finally {
    cancel();
  }
}
```

That handler is **stateless**, and that is a property the map version cannot have.
Signals reach every replica of the plugin, so whichever replica hears the stop can
abort the query — including one that never accepted the job, and including a replica
that started after the job did. The map version could only abort from the one process
still holding the entry.

Two consequences to design for:

- **Make the abort idempotent.** With several replicas, several `DELETE`s may arrive
  for one query. Joern should answer the second one `404`/`204` rather than erroring —
  or the plugin should treat those as success.
- **Filter on the conclusion.** Signals are published for *every* ending, `done`
  included. `canceled()` is the set that means "cut short" (`flow_stop_by_user`,
  `stop_command`, `timeout`, `long_time_without_command`); aborting on `done` would
  cancel a query that already finished.

### Cleanup tied to the job instead of the port

When the compensation belongs to this process's job rather than to any replica —
closing a stream, releasing a lease, deleting a scratch artefact — hang it off the
job's context instead of the signal port. The context ends however the job ends:
handler returned, stop, rejection, `cancelAll`.

```ts
ctx.onDone((cause) => {
  if (cause === jobstop.ErrStopped) void joern.cancel(queryId);
});
```

Because the context also ends when a **later middleware function rejects the
request**, this is the compensation hook for a half-built pipeline: a function that
enlisted work upstream registers its undo with `onDone`, and a rejection two
functions later undoes it without any special casing. Verified by *"a rejection after
registration runs the onDone compensation"*.

---

## 5. Why this is a distributed transaction

The flow's run and the Joern query are two independent systems that must begin
together, end together, and never disagree about what work exists. There is no
two-phase-commit coordinator between them and there cannot be — but the SDK's accept
stage gives the pattern the one thing 2PC provides: **a boundary where the two sides
are known to agree**, with compensations on either side of it.

| Transaction concept | Where it lives here |
|---|---|
| Transaction id | The shared `jobId` = Joern's `queryId`. One name, both sides. |
| `BEGIN` / enlist the participant | `registerQuery` — a middleware function, before accept. |
| Prepare → commit boundary | **Accept**: the SDK replies the `jobId`. Before it, nothing is visible to the runtime; after it, the job exists on both sides under one name. |
| Abort before commit | A middleware throw → the request is rejected. The runtime sees an error, not a failed node. |
| Compensating action | `joern.cancel` — from `ctx.onDone` (this job) or from the signal handler (any replica). |
| Work phase | The handler, polling under the shared id. |
| `COMMIT` / `ROLLBACK` reported | `job.done(...)` / `job.doneWithError(...)`. |
| Abort broadcast from the coordinator | The `proc` signal with `canceled()`. |
| Recovery log, read on restart | `_registry.jobId` — the previous run's id, which is also the upstream id. |
| Participant discovery | None needed: the id resolves in both systems. |

The invariants that fall out, and the reason each holds:

1. **Accepted ⇒ enlisted.** The namer runs before accept, so the runtime never knows
   a job whose upstream work does not exist.
2. **Enlisted ⇒ nameable.** The id came *from* the service, so there is no upstream
   work the plugin cannot address — not even after a restart.
3. **Rejected ⇒ compensated or never enlisted.** The job's context ends on rejection,
   so `onDone` undos run; a namer that failed registered nothing.
4. **Any stop is actionable by any replica.** The abort needs only `sig.jobId`.
5. **Crash ⇒ recoverable.** The id survives in the flow's own record (`_registry`),
   not in the plugin's memory, so the next run reattaches instead of duplicating.

What it is *not*: atomic. A crash between `register` and the accept reply leaves a
query running that this run will never report (invariant 1 covers the runtime's view,
not the service's). That residue is bounded and self-describing — the query exists,
named, under the project it was registered for — so the usual answers are a TTL on the
service side, or a sweeper that cancels queries no flow is attending. This is a saga,
not 2PC: compensation, not locking.

### Resuming: job discovery across runs

The same property makes a re-run cheap. `_registry.jobId` is the previous run's id,
which *is* the upstream query's id, so the namer can ask the service whether that work
is still alive and adopt it instead of registering again:

```ts
const prev = input._registry?.jobId as string | undefined;
if (prev && (await joern.alive(prev))) return withJobIDContext(ctx, prev);
```

The new run then reports progress on `inflow.cpu.<id>.q-8f21c47b3d.progress` and
finishes the work the previous process started — an hour of CPG construction not
thrown away because a flow was restarted. Taken to its conclusion, the run need not
wait for the work at all: it can report where the work has got to and end, leaving a
later run to collect it. That is [detached-work.md](detached-work.md). With two id
spaces this is simply not expressible: the previous `jobId` means nothing to Joern,
and the map that once translated it is gone.

---

## 6. Rules, limits and failure modes

**The id must be at least 10 characters.** This one bites hardest, because the service
decides the length. fractal-core's plugin node refuses an init reply whose `jobId` is
shorter than 10 characters and fails the node with `init failed. invalid job ID`
(`engine/prim_nodes/plugin.go`). A uuid is 36, so the default namer never trips it —
but `q-7`, `#412` and `job12` do. Pad or prefix a short upstream id into something
stable and reversible (`joern-00000412`, or the scope prefix below), and validate it
in the namer rather than discovering it as a failed node.

**The jobId becomes a NATS subject token.** Commands are published to
`inflow.cpu.<PLUGIN_ID>.<JOB_ID>.<command>`, so an id containing `.`, a space, `*` or
`>` does not merely look odd — it changes the subject's structure and the job's
commands land nowhere. Validate the id you adopt (`unusableJobId` above) and reject,
or encode it (base32/hex of the upstream id) if the service's ids are arbitrary
strings. Never adopt an id straight out of a response without checking.

**The id must be unique across the plugin, not just per project.** Services that
number work per tenant or per project (`#1`, `#2`) will collide: two flows get one
`jobId`, and their commands and stops interleave. Prefix with the scope —
`proj42-#1` — so the result is unique for the whole plugin.

**Registration happens inside the accept latency budget.** The runtime is waiting for
a `jobId` while your middleware runs, and it waits **15 seconds** (fractal-core's
`initRequestTimeout`) before failing the node as unreachable. One fast call is fine; a
30-second `POST`, a retry loop, or the work itself is not. Give the registration call
its own short timeout — `const [c, cancel] = ctx.withTimeout(5_000)`, then
`fetch(url, { signal: c.signal })` — and keep everything else in the handler.

**Reject or accept-then-fail is a design decision.** A middleware throw means the node
*never ran*: the runtime gets an error in place of a `jobId`, and there is no job for
the flow to show as failed. When the flow should see a failed node with a message,
scope or a partial result instead, accept the job and fail it from the handler with
`job.doneWithError` / `job.doneWithErrorData`. Rule of thumb: reject when there is
nothing to report, fail the job when there is.

**Requests can be retried; registration should be idempotent.** A redelivered
execution request runs the pipeline again and would register a second query. Where the
service supports a client-supplied idempotency key, derive one from the request (the
flow's node + input hash) and pass it; otherwise check `_registry` first, as above.

**Nameless jobs are rejected.** If the namer binds no id, the SDK rejects the request
rather than accept a job named `""`. A namer that may legitimately fall back must bind
something — e.g. `withJobIDContext(ctx, randomUUID())`.

**`castRequestTo` throws on bad JSON.** In the handler that is a `doneWithError`; in
the namer it is a rejection, which is usually what you want (nothing was enlisted) —
but wrap it if you would rather report a failed node with a readable message.

### When *not* to adopt the external id

| Situation | Do this instead |
|---|---|
| The service names the work only *after* it starts (the id arrives on the first streamed event) | Keep the SDK's uuid; correlate in the handler, which holds both ids for the whole job's life, and use `jobstop` as usual. |
| Registration is slow or unreliable | Keep the uuid and register in the handler, reporting failure with `doneWithError`. Accept latency is not the place to fight a flaky backend. |
| The service **accepts** a client-supplied id (idempotency keys, run ids, external ids) | **Impose** instead of adopt: keep `jobID`'s uuid and send `job.jobId` upstream as the service's id. Same single-name benefit, no validation worries, and the registration becomes idempotent by construction. |
| The action does no external I/O at all (a transform, a context read) | Nothing to do: the default `jobID` is right, and the action needs no middleware. |

Adopt or impose, the goal is the same and so is the place it is decided: **one name
for one piece of work, settled before the job is accepted.**

---

## 7. Checklist

- [ ] The namer is the **first** middleware function of the action (or `withJobID` for
      a whole-plugin proxy).
- [ ] `stops.middleware` and anything else keyed on the `jobId` comes **after** it.
- [ ] The adopted id is validated: **≥ 10 characters**, a usable subject token, and
      unique plugin-wide.
- [ ] Registration has its own timeout and does no real work.
- [ ] Failure to register → reject; failure the flow should see → accept and
      `doneWithError`.
- [ ] `p.onSignal(...)` is registered **before** `start()` — without it the port is
      not subscribed and no stop ever arrives (`start()` logs
      `Signals not subscribed on …`).
- [ ] The signal handler filters `sig.kind === PluginSignal.Proc` and
      `canceled(sig.conclusion)`.
- [ ] The upstream abort is idempotent across replicas.
- [ ] The handler checks `ctx.canceled` before reporting, and does not report after a
      stop.
- [ ] The namer consults `_registry.jobId` if re-running should reattach.

## See also

- [detached-work.md](detached-work.md) — the pattern this one enables: work that
  outlives the flow run, observed across runs through `_registry`.
- [jobs-and-commands.md § Middleware](jobs-and-commands.md#middleware--functions-run-before-the-job-is-accepted) — the pipeline, context flow, rejection semantics.
- [jobs-and-commands.md § Signals](jobs-and-commands.md#signals--when-the-runtime-ends-a-process) — the port, conclusions, why stopping is opt-in.
- [protocol-inflowv1.md](protocol-inflowv1.md) — the handshake that carries the
  `jobId`, and the signal payload.
- [`tests/jobstop.test.ts`](../tests/jobstop.test.ts) — this pattern's properties as
  executable tests.
- [cookbook.md § Skill 14](../cookbook.md#skill-14--run-the-job-under-an-external-services-id-advanced) — the condensed recipe.
- The Go SDK's [external-job-identity.md](https://github.com/Inflowenger/go-plugin-sdk/blob/main/docs/external-job-identity.md)
  — the same pattern in Go, which this SDK mirrors.
