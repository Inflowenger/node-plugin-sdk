// HTTP.CALL sample plugin — the Node equivalent of TestInit in sdkv1_test.go.
// Run: npm run example:http   (after setting .env.inflow)
import {
  newPlugin,
  withDotEnv,
  castRequestTo,
  type Job,
} from "@inflowenger/node-plugin-sdk";

async function main() {
  const p = await newPlugin(withDotEnv(".env.inflow"));

  p.intro({ name: "HTTP.CALL", author: "inflow Dev. Team", version: "v0.0.1" });

  // Action 1: perform a real outbound HTTP request driven by the node's form.
  p.addAction({
    method: "http.call",
    title: "HTTP Call",
    description: "Perform an outbound HTTP request",
    requestHandler: async (job: Job) => {
      type Input = {
        url: string;
        method: string;
        headers?: Record<string, string>;
        body?: Record<string, unknown>;
      };

      let req;
      try {
        req = castRequestTo<Input>(job.req.data);
      } catch (e) {
        await job.doneWithError(String(e));
        return;
      }

      // _registry carries this node's previous run (idempotency / resume).
      if (req._registry?.jobId) {
        const doneAt = new Date(Number(req._registry.doneAt) * 1000);
        console.log(
          `This node's previous run had jobId ${req._registry.jobId}, done at ${doneAt}`,
        );
      }

      console.log(`REQUEST URL: ${req.body.url}`);

      await job.progress(10, { title: "init step", content: "given task is in progress" });
      await job.progress(20, { title: "working", content: "task is being processed" });

      try {
        const resp = await fetch(req.body.url, {
          method: req.body.method,
          headers: { "Content-Type": "application/json", ...(req.body.headers ?? {}) },
          body: req.body.body ? JSON.stringify(req.body.body) : undefined,
        });

        const raw = await resp.text();
        let doneBody: Record<string, unknown>;
        try {
          doneBody = JSON.parse(raw);
        } catch {
          doneBody = { rawBody: raw };
        }

        await job.progress(80, { title: "almost done", content: "" });
        await job.done(doneBody);
      } catch (e) {
        await job.doneWithError(String(e));
      }
    },
  });

  // Action 2: read + write flow context.
  p.addAction({
    method: "fn",
    requestHandler: async (job: Job) => {
      const cur = await job.cmdGetCurrentScope();
      console.log("GetCurrent", new TextDecoder().decode(cur));

      const scope = await job.cmdGetScope("$.OPA");
      console.log("Scope : ", new TextDecoder().decode(scope));

      await job.cmdSetOnPath(`$["doc appendix"]`, {
        itemXterm: [1, 3, 42, 2300],
      });
      // await job.cmdStopFlow();
      await job.done({ action: "done finally...." });
    },
  });

  p.start();
  // keep the process alive to serve requests
  await new Promise(() => {});
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
