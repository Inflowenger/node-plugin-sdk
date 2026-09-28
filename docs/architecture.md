# Architecture — the Plugin node in Inflowenger

This document places the Plugin node in the wider Inflowenger runtime and describes a
plugin's lifecycle. For the exact messages on the wire, see
[protocol-inflowv1.md](protocol-inflowv1.md). The platform model is identical across
the Go and Node SDKs — only the client language differs.

## The Inflowenger computational model

Inflowenger is a **runtime for context processing**. Its model has four parts:

| Concept       | Role                                                                 |
|---------------|----------------------------------------------------------------------|
| **Context**   | The memory. Everything enters as context; a running flow reads and writes a shared context tree. |
| **Workflows** | The logic. Business logic is expressed as a **workflow graph** — visible, traceable, and safe to change. |
| **Fractals**  | The processors. The runtime instances that actually execute workflow graphs. |
| **Adapters**  | The edges. They connect the runtime to the outside world. |

By analogy to a computer: a **Fractal** is the process/OS, a **Workflow** is a
program, **Context** is memory, and **Plugins** are the extensions, drivers, and
interrupts.

A workflow is a graph of **nodes**. Inflowenger provides a small set of **primitive
nodes**; higher-level node types are compiled down to those primitives. The **Plugin
node** is different — it is a live external process the Fractal calls into at run
time, which is what makes it the ecosystem's richest and most extensible node type.

## Where a plugin runs

A plugin is **your** process. It does not run inside the Fractal; it connects to the
platform's NATS server (exposed by Infra) and subscribes to subjects namespaced under
its `PLUGIN_ID`. When the Fractal reaches your node in a flow, it publishes a request
to one of those subjects and consumes the responses.

```
                 workflow graph (on the canvas)
                          │
                   ┌──────▼───────┐
                   │  Fractal     │   executes the graph
                   │  (runtime)   │
                   └──────┬───────┘
                          │  NATS  (subjects: inflow.v1.* / inflow.cpu.*)
        ┌─────────────────▼──────────────────┐
        │  Infra  (embedded NATS + accounts)  │
        └─────────────────┬──────────────────┘
                          │  NATS
                   ┌──────▼───────┐
                   │ Your Plugin  │   this SDK — an ordinary Node process
                   │  process     │   holds connections, runs loops, calls APIs
                   └──────────────┘
```

Because the plugin is a persistent process rather than a compiled node, it can hold
long-running state, originate events, act as an adapter, and be deployed/versioned on
its own cadence.

## Lifecycle of a plugin process

1. **Construct.** `newPlugin(...opts)` loads credentials and opens the NATS
   connection (see [`withDotEnv` / `withInfraConnection`](../src/plugin.ts)).
2. **Declare identity.** `p.intro({...})` sets the name/author/version shown for the
   plugin.
3. **Declare requirements (optional).** `p.requiredParams({...})` registers a
   settings form and submit handler.
4. **Declare actions.** `p.addAction({...})` adds one or more methods, each with its
   own form and `requestHandler`.
5. **Listen for signals (optional).** `p.onSignal(handler)` registers a handler for
   the runtime's one-way signal port — told when a process the plugin ran has ended,
   and how. Skip it unless the plugin holds work that must stop with the process; see
   [jobs-and-commands.md § Signals](jobs-and-commands.md#signals--when-the-runtime-ends-a-process).
6. **Start.** `p.start()` subscribes to every subject: intro, settings, the action
   list, each action's form, each action's executor, and the signal port if a handler
   was registered. It returns immediately.
7. **Block & serve.** `await new Promise(() => {})` keeps the process alive. From here
   it is request-driven.

```ts
const p = await newPlugin(withDotEnv(".env.inflow"));
p.intro({ name: "HTTP.CALL", author: "inflow Dev. Team", version: "v0.0.1" });
p.addAction({ method: "http.call", requestHandler: handler });
p.start();
await new Promise(() => {});
```

## Two kinds of interaction

The runtime talks to a plugin in two registers, and the **subject naming tells you
which is which**:

- **UI & arguments (discovery).** "What are you? What can you do? What does this
  action's form look like?" Request/reply lookups on `inflow.v1.*`, each carrying an
  **`@`-prefixed** segment (`@intro`, `@settings`, `@actions`, `@form`). The `@` marks
  it as UI/arguments metadata — answered from the values you declared, nothing runs.
- **Execution (the `cpu` call).** "Run action X with this input." This is the node's
  **main call**, requested by the Fractal at runtime on `inflow.cpu.*`. It starts a
  **Job**: the plugin immediately acknowledges with a `jobId`, then works
  asynchronously — streaming `progress`, reading/writing context, and finally `done`.

Rule of thumb: a subject with a `@` part is *describe/configure me*; a subject under
`cpu` is *run me*. See [jobs-and-commands.md](jobs-and-commands.md).

Both registers are request/reply, and both are opened by the runtime asking the
plugin something. There is one channel that is neither: the **signal port** on
`inflow.plugin.<PLUGIN_ID>.*`, where the runtime *broadcasts* what became of a
process it ran — finished, stopped by the user, timed out. Nothing is expected back,
and a plugin is free never to listen. It exists for the minority of plugins whose
in-flight work must end when the process does; the default, quite deliberately, is
that a job outlives the process that started it. See
[jobs-and-commands.md § Signals](jobs-and-commands.md#signals--when-the-runtime-ends-a-process).
