// Composing signal handlers, and the one that just logs. Mirrors sdkv1/compose.go.
import type { Signal, SignalHandler } from "./models.js";
import { canceled, PluginSignal, succeeded } from "./types.js";

const decoder = new TextDecoder();

/**
 * Compose signal handlers into one, so the plugin's single signal port
 * (`Plugin.onSignal`) serves any number of them. Each handler sees every signal,
 * in order, and an async one is awaited before the next runs. A throw (or
 * rejection) in one is caught and logged, so it cannot keep the handlers after
 * it — a cancellation, say — from seeing the signal. Empty entries are skipped.
 *
 * ```ts
 * p.onSignal(chainSignals(stops.onSignal, audit));
 * ```
 */
export function chainSignals(
  ...handlers: Array<SignalHandler | undefined | null>
): SignalHandler {
  const chain = handlers.filter((h): h is SignalHandler => typeof h === "function");
  return async (sig: Signal) => {
    for (const handler of chain) {
      try {
        await handler(sig);
      } catch (err) {
        console.log(`signal handler failed on ${sig.subject}:`, err);
      }
    }
  };
}

/**
 * A SignalHandler that prints one line per signal that lands on the plugin's
 * signal port, so what the runtime published is visible in the plugin's log the
 * moment it arrives. `prefix` names the plugin in the line (pass "" for none):
 *
 * ```
 * ai-decision: signal proc job=<uuid> conclusion=flow_stop_by_user canceled=true succeeded=false
 * ```
 *
 * It is read-only — acting on a conclusion is another handler's job — so it
 * belongs beside the one that does, which is why `Plugin.onSignal` takes a
 * single handler and this composes:
 *
 * ```ts
 * p.onSignal(chainSignals(logSignals("ai-decision"), stops.onSignal));
 * ```
 *
 * Registering a cancellation handler alone replaces the default handler
 * `onSignal()` installs, and with it the only sight of the port; chain this to
 * keep it.
 *
 * This is the signal ARRIVING, which is not the same event as a job being cut
 * short: `jobstop.Registry.onSignal` logs that separately, for the jobs it
 * holds. The two lines together read as the whole story — what the runtime said,
 * and what this process did about it — and a signal with no cancel line was for
 * a job this process is not running, or concluded a job that was already done.
 *
 * Note what a logged jobId does NOT mean. The runtime publishes process signals
 * on ONE subject per plugin, so every process of a plugin sees every one of that
 * plugin's signals: jobs of other flows running at the same time, and, when the
 * plugin runs as several replicas, jobs this process never accepted. Lines for
 * jobs this process knows nothing about are the ordinary case.
 *
 * A kind this SDK does not model carries no typed fields, so its line gives the
 * subject and the raw payload instead.
 */
export function logSignals(prefix: string): SignalHandler {
  const tag = prefix === "" ? "" : `${prefix}: `;
  return (sig: Signal) => {
    if (sig.kind !== PluginSignal.Proc) {
      console.log(
        `${tag}signal ${sig.kind} subject=${sig.subject} data=${decoder.decode(sig.data)}`,
      );
      return;
    }
    console.log(
      `${tag}signal ${sig.kind} job=${sig.jobId} conclusion=${sig.conclusion} ` +
        `canceled=${canceled(sig.conclusion)} succeeded=${succeeded(sig.conclusion)}`,
    );
  };
}
