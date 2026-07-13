# Examples

Two runnable sample plugins live in [`../examples/`](../examples): `http-call.ts`
(the Node equivalent of the Go SDK's `TestInit`) and `rpc.ts` (equivalent to
`TestCommands`). Each connects to a live platform and blocks forever, so they behave
as long-running plugin processes.

Point [`.env.inflow`](../.env.inflow.example) at your running Infra
(`PLUGIN_ID` / `INFRA_CRED` / `INFRA_URL`), then:

```bash
npm install
npm run example:http   # the HTTP.CALL plugin
npm run example:rpc    # the RPC plugin
```

Stop with `Ctrl-C`.

---

## 1. `HTTP.CALL` — an outbound HTTP adapter

A plugin exposing two actions: `http.call` (a real HTTP request driven by the node's
form, using the global `fetch`) and `fn` (a context read/write demo). This is the
canonical **adapter plugin** shape: typed input, external work, streamed progress,
committed result.

```ts
const p = await newPlugin(withDotEnv(".env.inflow"));
p.intro({ name: "HTTP.CALL", author: "inflow Dev. Team", version: "v0.0.1" });

p.addAction({
  method: "http.call",
  title: "HTTP Call",
  requestHandler: async (job: Job) => {
    type Input = {
      url: string; method: string;
      headers?: Record<string, string>; body?: Record<string, unknown>;
    };

    // 1. Parse the request into a typed struct.
    let req;
    try { req = castRequestTo<Input>(job.req.data); }
    catch (e) { await job.doneWithError(String(e)); return; }

    // 2. _registry carries this node's previous run (idempotency, resume).
    if (req._registry?.jobId) {
      const doneAt = new Date(Number(req._registry.doneAt) * 1000);
      console.log(`previous run ${req._registry.jobId} done at ${doneAt}`);
    }

    // 3. Stream progress to the canvas.
    await job.progress(10, { title: "init step", content: "given task is in progress" });
    await job.progress(20, { title: "working", content: "task is being processed" });

    // 4. Do the work — an outbound HTTP request built from the form input.
    try {
      const resp = await fetch(req.body.url, {
        method: req.body.method,
        headers: { "Content-Type": "application/json", ...(req.body.headers ?? {}) },
        body: req.body.body ? JSON.stringify(req.body.body) : undefined,
      });
      const raw = await resp.text();

      // 5. Shape the output; fall back to a raw body if it isn't JSON.
      let doneBody: Record<string, unknown>;
      try { doneBody = JSON.parse(raw); } catch { doneBody = { rawBody: raw }; }

      await job.progress(80, { title: "almost done", content: "" });

      // 6. Finish — commits doneBody as this node's output.
      await job.done(doneBody);
    } catch (e) {
      await job.doneWithError(String(e));
    }
  },
});
```

The second action shows context injection:

```ts
p.addAction({
  method: "fn",
  requestHandler: async (job: Job) => {
    console.log("GetCurrent", new TextDecoder().decode(await job.cmdGetCurrentScope()));
    console.log("Scope :", new TextDecoder().decode(await job.cmdGetScope("$.OPA")));
    await job.cmdSetOnPath(`$["doc appendix"]`, { itemXterm: [1, 3, 42, 2300] });
    // await job.cmdStopFlow();  // uncomment to abort the whole flow here
    await job.done({ action: "done finally...." });
  },
});

p.start();
await new Promise(() => {});
```

Takeaways:

- **One plugin, many actions.** Each `addAction` is a separately-invokable method.
- **Typed input via generics.** `castRequestTo<T>` unwraps the `{ _registry, body }`
  envelope (it throws on bad JSON — wrap it).
- **Fail fast.** Any error path `await`s `job.doneWithError` and returns.
- **Progress is cosmetic; `done` is terminal.**

---

## 2. `RPC` — a pure context function

A minimal plugin whose single `fn` action only reads context and returns — the shape
of a **logic/transform node**.

```ts
const p = await newPlugin(withDotEnv(".env.inflow"));
p.intro({ name: "RPC", author: "inflow Dev. Team", version: "v0.0.1" });

p.addAction({
  method: "fn",
  requestHandler: async (job: Job) => {
    console.log("GetCurrent", new TextDecoder().decode(await job.cmdGetCurrentScope()));
    console.log("Scope :", new TextDecoder().decode(await job.cmdGetScope("$.OPA")));
    // await job.cmdStopFlow();
    await job.done({ action: "done" });
  },
});

p.start();
await new Promise(() => {});
```

Same skeleton, no adapter work — proof of how little a functional node needs.

---

## Adapting these into your own plugin

1. Copy one handler into your own entry file.
2. Give the plugin a real `PLUGIN_ID` and point `INFRA_CRED` / `INFRA_URL` at your
   platform.
3. Add a `form` (JSON Schema + UI Schema) to each action — see
   [form-builder.md](form-builder.md).
4. `p.start()` then block with `await new Promise(() => {})`.
