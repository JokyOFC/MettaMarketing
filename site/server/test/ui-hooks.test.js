// Front-end kit: what useApi shows while its path changes (pure part of the hook).
// Regression: the first render after a path change used to return the previous
// path's payload (the reset only happened in the fetch effect), which crashed
// the Relatórios tabs that read another endpoint's fields.
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveApiState } from "../../src/app/ui/hooks.js";

const A = "/reports/deliveries";
const B = "/reports/approvals";
const payloadA = { series: [{ period: "2026-09", value: 3 }], totals: { onTime: 0.5 } };

test("a new path never exposes the previous path's payload", () => {
  const loadedA = { data: payloadA, error: null, pending: false, path: A };
  assert.equal(resolveApiState(loadedA, A).data, payloadA);

  // Render right after the path changed, before the fetch effect ran.
  const view = resolveApiState(loadedA, B);
  assert.equal(view.data, undefined);
  assert.equal(view.loading, true);
  assert.equal(view.refreshing, false);
  assert.equal(view.error, null);

  // The effect started the fetch for B (state now belongs to B, still empty).
  const pendingB = { data: undefined, error: null, pending: true, path: B };
  assert.deepEqual(resolveApiState(pendingB, B), {
    data: undefined,
    error: null,
    loading: true,
    refreshing: false,
  });
});

test("initialData stands in while the new path loads", () => {
  const loadedA = { data: [1, 2, 3], error: null, pending: false, path: A };
  const view = resolveApiState(loadedA, B, []);
  assert.deepEqual(view.data, []);
  assert.equal(view.refreshing, true);
  assert.equal(view.loading, false);
});

test("an error from another path is not shown", () => {
  const failedA = { data: undefined, error: new Error("boom"), pending: false, path: A };
  assert.equal(resolveApiState(failedA, A).error.message, "boom");
  assert.equal(resolveApiState(failedA, B).error, null);
});

test("same path refetch keeps data on screen as refreshing", () => {
  const refetching = { data: payloadA, error: null, pending: true, path: A };
  const view = resolveApiState(refetching, A);
  assert.equal(view.data, payloadA);
  assert.equal(view.refreshing, true);
  assert.equal(view.loading, false);
});

test("a null path pauses and keeps the last payload (closing drawers do not flash)", () => {
  const loadedA = { data: payloadA, error: null, pending: true, path: A };
  const view = resolveApiState(loadedA, null);
  assert.equal(view.data, payloadA);
  assert.equal(view.loading, false);
  assert.equal(view.refreshing, false);
  // Reopening another record after the pause starts empty again.
  const paused = { ...loadedA, pending: false, path: null };
  assert.equal(resolveApiState(paused, B).data, undefined);
  assert.equal(resolveApiState(paused, B).loading, true);
});
