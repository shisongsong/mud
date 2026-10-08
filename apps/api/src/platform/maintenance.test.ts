import assert from "node:assert/strict";
import { test } from "node:test";
import { startMaintenance } from "./maintenance.ts";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("maintenance keeps running the remaining tasks after one fails", async () => {
  const errors: string[] = [];
  let healthyRuns = 0;
  const stop = startMaintenance({
    intervalMs: 5,
    tasks: [
      {
        name: "failing",
        run: () => Promise.reject(new Error("boom")),
      },
      {
        name: "healthy",
        run: async () => {
          healthyRuns += 1;
        },
      },
    ],
    onError: (taskName) => errors.push(taskName),
  });

  await wait(40);
  await stop();

  assert.ok(healthyRuns > 0);
  assert.ok(errors.length > 0);
  assert.ok(errors.every((name) => name === "failing"));
});

test("maintenance does not overlap ticks while a tick is in flight", async () => {
  let active = 0;
  let maxActive = 0;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const stop = startMaintenance({
    intervalMs: 2,
    tasks: [
      {
        name: "slow",
        run: async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await gate;
          active -= 1;
        },
      },
    ],
    onError: () => undefined,
  });

  await wait(30);
  release();
  await stop();

  assert.equal(maxActive, 1);
});

test("stop waits for the in-flight tick and prevents further ticks", async () => {
  let finished = false;
  let runs = 0;
  const stop = startMaintenance({
    intervalMs: 2,
    tasks: [
      {
        name: "slow",
        run: async () => {
          runs += 1;
          await wait(20);
          finished = true;
        },
      },
    ],
    onError: () => undefined,
  });

  await wait(5);
  await stop();
  assert.equal(finished, true);

  const runsAtStop = runs;
  await wait(20);
  assert.equal(runs, runsAtStop);
});

test("maintenance rejects a non-positive interval", () => {
  assert.throws(
    () =>
      startMaintenance({ intervalMs: 0, tasks: [], onError: () => undefined }),
    TypeError,
  );
});
