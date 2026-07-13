# Inflowenger Node Plugin SDK (`inflowv1`)

> The Node.js / TypeScript SDK for building **Plugin nodes** in the
> [Inflowenger](https://github.com/Inflowenger/getting-started) ecosystem — the
> Node port of [`go-plugin-sdk`](https://github.com/Inflowenger/go-plugin-sdk).

`@inflowenger/node-plugin-sdk` lets you write a small Node program that shows up on
the Inflowenger workflow canvas as a **node** — with its own UI form, its own
actions, live progress feedback, and full read/write access to the flow's context —
while running as an ordinary process you own and deploy anywhere.

It speaks **`inflowv1`**, the same message protocol the runtime (Fractal) uses to
talk to plugins over [NATS](https://nats.io). Its wire format is identical to the Go
SDK's, so a Node plugin and a Go plugin are interchangeable from the runtime's point
of view — pick the language, not a different protocol.

```ts
import { newPlugin, withDotEnv, castRequestTo, type Job } from "@inflowenger/node-plugin-sdk";

const p = await newPlugin(withDotEnv(".env.inflow"));

p.intro({ name: "HTTP.CALL", author: "inflow Dev. Team", version: "v0.0.1" });

p.addAction({
  method: "http.call",
  requestHandler: async (job: Job) => {
    const req = castRequestTo<{ url: string; method: string }>(job.req.data);
    await job.progress(20, { title: "calling", content: req.body.url });
    // ... do the work ...
    await job.done({ status: "ok" });
  },
});

p.start();
await new Promise(() => {}); // block forever, serving requests
```

---

## Why a Plugin node?

Inflowenger is a runtime for building software whose **logic is defined as a
workflow graph** — think n8n, but as a general computational substrate. The platform
ships a handful of **primitive nodes**; every higher-level node ultimately compiles
down to those. The **Plugin node is the exception** — a live external process the
runtime calls into, making it the full-featured extension point of the ecosystem:

- **Context injection** — read/write the running flow's shared context by JSON path.
- **Flow control** — report progress, finish a job, or **stop the flow**.
- **Long-running work & events** — a persistent process can hold connections, run
  loops, and surface external systems as nodes.
- **Adapters** — bridge Inflowenger to any external system.
- **Its own UI** — each action carries a form (JSON Schema + UI Schema, rendered by
  [JSON Forms](https://jsonforms.io)).

For the concepts, see [docs/architecture.md](docs/architecture.md).

---

## Installation

> **Not on the npm registry yet.** Install it **from git**. npm clones the repo and
> runs the package's `prepare` script to compile `dist/` on install — no separate
> build step needed.

**From the GitHub repo:**

```bash
npm install github:Inflowenger/node-plugin-sdk
```

**Or pin it in your `package.json`** and `npm install`:

```jsonc
{
  "dependencies": {
    "@inflowenger/node-plugin-sdk": "github:Inflowenger/node-plugin-sdk"
  }
}
```

> Pin a tag or commit for reproducible installs, e.g.
> `github:Inflowenger/node-plugin-sdk#v0.0.1`. Once the package is published, plain
> `npm install @inflowenger/node-plugin-sdk` will be the norm.

Requires **Node 18+** (uses the global `fetch` and Web Crypto). ESM only. A reachable
Inflowenger platform (Infra + at least one Fractal) is needed to run against — see
[getting-started](https://github.com/Inflowenger/getting-started).

---

## Configuration

A plugin needs three values, via a dotenv file (or the explicit options):

| Variable     | Meaning                                                                 |
|--------------|-------------------------------------------------------------------------|
| `PLUGIN_ID`  | The plugin's identity. All of its NATS subjects are namespaced under it. |
| `INFRA_CRED` | **Base64-encoded** NATS user credentials (JWT + NKey seed) minted by Infra. |
| `INFRA_URL`  | NATS endpoint of the platform, e.g. `localhost:4222`.                   |

```env
# .env.inflow
PLUGIN_ID=aa-bbb-ccc-dddd
INFRA_CRED=LS0tLS1CRUdJTiBOQVRTIFVTRVIgSldULS0t...   # base64 of the .creds file
INFRA_URL=localhost:4222
```

Three ways to construct a plugin:

```ts
// 1. From a dotenv file (reads PLUGIN_ID / INFRA_CRED / INFRA_URL)
const p = await newPlugin(withDotEnv(".env.inflow"));

// 2. Explicit connection + id
const p = await newPlugin(
  withInfraConnection("localhost:4222", base64Cred),
  withPluginId("aa-bbb-ccc-dddd"),
);
```

### Where these values come from — provisioning a plugin

A plugin must first be **defined in a space** — a NATS **account** managed by Infra,
the unit of authentication, authorization, and isolation. Inflow ships a **built-in
plugins space** for single-tenant setups; **multi-tenant / enterprise** deployments
define plugins in **custom accounts** to isolate accessibility and scope domains.
Only after that definition does Infra give you `INFRA_CRED` (which *carries the
account*, so it is the authorization boundary), `PLUGIN_ID`, and `INFRA_URL` (always
required — Infra may be a **cluster with multiple endpoints**). This matches the Go
SDK exactly; see the [Go README](https://github.com/Inflowenger/go-plugin-sdk#where-these-values-come-from--provisioning-a-plugin).

---

## The shape of a plugin

```ts
const p = await newPlugin(withDotEnv(".env.inflow"));

// 1. Identity — shown on the canvas / node palette
p.intro({ name: "HTTP.CALL", author: "inflow Dev. Team", version: "v0.0.1" });

// 2. (optional) Onboarding / settings form + submit handler
p.requiredParams({
  jsonschema: schema,
  jsonui: ui,
  submitHandler: (r) => ({ data: { ok: true } }),
});

// 3. One or more actions
p.addAction({
  method: "http.call",
  title: "HTTP Call",
  description: "Perform an outbound HTTP request",
  form: { jsonschema: schema, jsonui: ui },
  requestHandler: async (job) => { /* the work */ },
});

// 4. Start serving and block
p.start();
await new Promise(() => {});
```

`start()` wires up all the NATS subscriptions and returns. Because the SDK serves
asynchronously, your entry point must stay alive afterwards (`await new Promise(() => {})`).

---

## Inside an action handler (`Job`)

```ts
async (job: Job) => {
  // Parse the request body. RequestBody wraps { _registry, body }.
  let req;
  try {
    req = castRequestTo<MyInput>(job.req.data);
  } catch (e) {
    await job.doneWithError(String(e));
    return;
  }

  // Metadata about this node's previous run.
  if (req._registry?.jobId) console.log("previous run:", req._registry.jobId);

  // Stream progress back to the canvas (0–100).
  await job.progress(20, { title: "working", content: "calling upstream" });

  // Read the flow's shared context (returns Uint8Array).
  const current = await job.cmdGetCurrentScope();
  const opa = await job.cmdGetScope("$.OPA");

  // Write into the flow's context at a JSON path.
  await job.cmdSetOnPath(`$["result"]`, { count: 42 });

  // Optionally abort the whole flow.
  // await job.cmdStopFlow();

  // Finish. Progress hits 100 and the payload is committed as output.
  await job.done({ ok: true });
}
```

| Method | Effect |
|--------|--------|
| `job.progress(pct, frame)` | Report progress `0–100` with a titled status frame. |
| `job.done(data, ...key)`   | Complete (progress 100) and emit `data`; optional key path to commit on. |
| `job.doneWithError(msg)`   | Complete with an error payload. |
| `job.cmdGetCurrentScope()` | Fetch the current context scope (`Uint8Array`). |
| `job.cmdGetScope(path)`    | Fetch a slice of context by JSON path. |
| `job.cmdSetOnPath(path, o)`| Commit data into the flow context at a JSON path. |
| `job.cmdStopFlow()`        | Stop the entire workflow run. |

Full semantics and the underlying subjects: [docs/jobs-and-commands.md](docs/jobs-and-commands.md).

---

## Documentation

| Doc | What's in it |
|-----|--------------|
| [cookbook.md](cookbook.md) | **Start here to build one** — a task-organized cookbook. |
| [docs/architecture.md](docs/architecture.md) | Where the plugin node sits in Inflowenger, and the plugin lifecycle. |
| [docs/protocol-inflowv1.md](docs/protocol-inflowv1.md) | The `inflowv1` wire protocol: subjects, request/response shapes, the job handshake. |
| [docs/jobs-and-commands.md](docs/jobs-and-commands.md) | The `Job` API in depth. |
| [docs/form-builder.md](docs/form-builder.md) | Building action & settings UIs with JSON Forms. |
| [docs/examples.md](docs/examples.md) | Annotated walkthrough of the `HTTP.CALL` and `RPC` sample plugins. |
| [docs/inflow-ecosystem.md](docs/inflow-ecosystem.md) | Working notes on the broader Inflowenger platform. |

**Building with an AI assistant:** a ready-made Agent Skill lives at
[`skills/inflow-plugin/SKILL.md`](skills/inflow-plugin/SKILL.md) — copy it into your
plugin project's `.claude/skills/` so a code agent auto-loads it.

---

## Running the samples

Two samples live in [`examples/`](examples): an `HTTP.CALL` plugin and an `RPC`
plugin. Point `.env.inflow` at your running Infra, then:

```bash
npm install
npm run build
npm run example:http   # HTTP.CALL plugin
npm run example:rpc    # RPC plugin
```

Both block forever and serve until interrupted — they are long-running plugin
processes.

---

## Repository layout

```
node-plugin-sdk/
├── src/                   the SDK (mirrors the Go sdkv1 package)
│   ├── plugin.ts          Plugin class, construction, options, NATS send
│   ├── inflowV1.ts        subject wiring: intro / settings / actions / forms
│   ├── job.ts             Job: progress, done, context commands
│   ├── req.ts             request parsing, castRequestTo, job handshake
│   ├── models.ts          protocol data types (PluginIntro, Action, FormBuilder, …)
│   ├── types.ts           command constants (progress/stop/context/commit)
│   ├── nats.ts            NATS connection from base64 decorated credentials
│   ├── env.ts             dotenv loading
│   └── index.ts           public API barrel
├── examples/              runnable sample plugins
├── cookbook.md            human-facing build guide
├── docs/                  concept & protocol docs
└── skills/inflow-plugin/  Agent Skill for AI coding assistants
```

---

## Relationship to the Go SDK

This is a faithful port of [`go-plugin-sdk`](https://github.com/Inflowenger/go-plugin-sdk): same subjects, same payloads,
same lifecycle. Naming follows each language's idiom (Go's `NewPlugin`/`AddAction` →
`newPlugin`/`addAction`; `job.Done` → `job.done`), and blocking I/O is `async`/`await`
instead of Go's synchronous calls. Like the Go SDK, meta-function **registration** is
not exported yet — use the settings `submitHandler` for live validation.

## License

See the repository root for license details.
