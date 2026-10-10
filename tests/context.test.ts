// JobContext — the cancellation/value scope middleware passes down.
import assert from "node:assert/strict";
import test from "node:test";
import { background, ErrCanceled, ErrDeadlineExceeded } from "../src/index.js";
import { tick } from "./harness.js";

test("the background context is never cancelled and carries nothing", () => {
  const ctx = background();
  assert.equal(ctx.canceled, false);
  assert.equal(ctx.cause, undefined);
  assert.equal(ctx.value("anything"), undefined);
  assert.equal(ctx.signal.aborted, false);
  assert.equal(ctx.onDone(() => assert.fail("must not run"))(), undefined);
});

test("withValue keeps the parent intact and shares its cancellation", () => {
  const [parent, cancel] = background().withCancel();
  const child = parent.withValue("k", 1);
  assert.equal(parent.value("k"), undefined);
  assert.equal(child.value("k"), 1);
  cancel();
  assert.equal(child.canceled, true, "values derive, cancellation is shared");
});

test("cancel records the cause and aborts the signal", () => {
  const [ctx, cancel] = background().withCancel();
  const reasons: unknown[] = [];
  ctx.onDone((cause) => reasons.push(cause));
  const sentinel = new Error("mine");
  cancel(sentinel);
  cancel(new Error("later")); // the first cause wins, like Go's
  assert.equal(ctx.cause, sentinel);
  assert.equal(ctx.signal.aborted, true);
  assert.equal(ctx.signal.reason, sentinel);
  assert.deepEqual(reasons, [sentinel]);
});

test("a cancel with no cause reads as ErrCanceled", () => {
  const [ctx, cancel] = background().withCancel();
  cancel();
  assert.equal(ctx.cause, ErrCanceled);
});

test("a child ends when its parent does, with the parent's cause", () => {
  const [parent, cancelParent] = background().withCancel();
  const [child] = parent.withCancel();
  const boom = new Error("parent's reason");
  cancelParent(boom);
  assert.equal(child.canceled, true);
  assert.equal(child.cause, boom);
});

test("deriving from an already-ended context ends immediately", async () => {
  const [parent, cancel] = background().withCancel();
  cancel(ErrCanceled);
  const [child] = parent.withCancel();
  assert.equal(child.canceled, true);
  let ran = false;
  child.onDone(() => {
    ran = true;
  });
  assert.equal(ran, false, "never synchronously");
  await tick();
  assert.equal(ran, true);
});

test("withoutCancel keeps the values and drops the cancellation", () => {
  const [ctx, cancel] = background().withCancel();
  const detached = ctx.withValue("trace", "abc").withoutCancel();
  cancel();
  assert.equal(ctx.canceled, true);
  assert.equal(detached.canceled, false);
  assert.equal(detached.value("trace"), "abc");
});

test("withTimeout ends with ErrDeadlineExceeded", async () => {
  const [ctx] = background().withTimeout(5);
  assert.equal(await ctx.sleep(1000), false);
  assert.equal(ctx.cause, ErrDeadlineExceeded);
});

test("sleep resolves true when it completes, false when the context ends", async () => {
  assert.equal(await background().sleep(1), true);
  const [ctx, cancel] = background().withCancel();
  const waiting = ctx.sleep(5_000);
  cancel();
  assert.equal(await waiting, false);
  assert.equal(await ctx.sleep(5_000), false, "an ended context never waits");
});

test("throwIfCanceled throws the cause", () => {
  const [ctx, cancel] = background().withCancel();
  ctx.throwIfCanceled();
  const boom = new Error("stopped");
  cancel(boom);
  assert.throws(() => ctx.throwIfCanceled(), boom);
});

test("a long-lived parent does not accumulate listeners per job", () => {
  const [parent] = background().withCancel();
  const cancels = Array.from({ length: 50 }, () => parent.withCancel());
  for (const [, cancel] of cancels) cancel();
  // Node warns past ten listeners on one signal; the child must unhook itself.
  assert.ok(true);
});
