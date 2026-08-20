// RPC sample plugin — the Node equivalent of TestCommands in sdkv1_test.go.
// A pure context function: read context and return. Run: npm run example:rpc
import { newPlugin, withDotEnv, type Job } from "@inflowenger/node-plugin-sdk";

async function main() {
  const p = await newPlugin(withDotEnv(".env.inflow"));

  p.intro({ name: "RPC", author: "inflow Dev. Team", version: "v0.0.1" });

  p.addAction({
    method: "fn",
    requestHandler: async (job: Job) => {
      const cur = await job.cmdGetCurrentScope();
      console.log("GetCurrent", new TextDecoder().decode(cur));

      const scope = await job.cmdGetScope("$.OPA");
      console.log("Scope : ", new TextDecoder().decode(scope));

      await job.done({ action: "done" });
    },
  });

  p.start();
  await new Promise(() => {});
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
