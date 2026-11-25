import { db, now, json } from "../db/db.js";
import { publish } from "../lib/events.js";
import { registerHandler, type JobCtx } from "../jobs/queue.js";
import { notify } from "../lib/audit.js";

/**
 * Fix-plan optimiser — QUANTUM-INSPIRED, runs on classical hardware.
 *
 * Problem: pick open findings to fix within an effort budget so that risk reduction is maximal.
 * Each finding i has value v_i (severity × confidence × architectural centrality of its file) and an
 * estimated cost c_i (hours, per-category estimates the user can edit). Fixing several findings in the
 * same file shares context, so pairs in one file get a cost discount (a quadratic, QUBO-style term).
 *
 *   E(x) = −Σ v_i x_i + λ · max(0, C(x) − B)²,   C(x) = Σ c_i x_i − δ Σ_{i<j, same file} min(c_i, c_j) x_i x_j
 *
 * Solver: Simulated Quantum Annealing (path-integral Monte Carlo). P Trotter replicas of the spin system are
 * coupled with J⊥ = −(P·T/2)·ln tanh(Γ/(P·T)); the transverse field Γ is lowered from Γ0 to ~0 so the replicas
 * tunnel between configurations early and freeze late. No quantum hardware is involved. The result is
 * compared against a greedy value/cost baseline and only reported as better when it actually is.
 */

export const DEFAULT_EFFORT: Record<string, number> = { secret: 0.5, dependency: 1, security: 2, bug: 1.5, performance: 2, debt: 3 };
const SEV: Record<string, number> = { critical: 25, high: 10, medium: 4, low: 1, info: 0.2 };
const CONF: Record<string, number> = { high: 1, medium: 0.7, low: 0.4 };
const SHARED = 0.25; // fraction of the smaller cost saved when two findings share a file

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Item = { id: string; title: string; source: string; severity: string; file: string | null; value: number; cost: number };

export function loadItems(repositoryId: string, effort: Record<string, number>, max = 120): Item[] {
  const d = db();
  const repo = d.prepare(`SELECT current_snapshot_id FROM repositories WHERE id = ?`).get(repositoryId) as any;
  const fanIn = new Map<string, number>();
  if (repo?.current_snapshot_id) {
    for (const r of d.prepare(`SELECT tf.path, COUNT(*) AS n FROM edges e JOIN files tf ON tf.id = e.target_file_id WHERE e.snapshot_id = ? AND e.kind = 'import' GROUP BY tf.path`).all(repo.current_snapshot_id) as any[]) fanIn.set(r.path, r.n);
  }
  const rows = d.prepare(`SELECT id, title, source, severity, confidence, file_path FROM findings WHERE repository_id = ? AND review_id IS NULL AND origin = 'detected' AND status IN ('open','triaged','in_progress')`).all(repositoryId) as any[];
  return rows
    .map((r) => ({
      id: r.id, title: r.title, source: r.source, severity: r.severity, file: r.file_path,
      value: Math.round((SEV[r.severity] ?? 1) * (CONF[r.confidence] ?? 0.5) * (1 + Math.log2(1 + (fanIn.get(r.file_path) ?? 0))) * 100) / 100,
      cost: Math.max(0.1, effort[r.source] ?? DEFAULT_EFFORT[r.source] ?? 2),
    }))
    .filter((x) => x.value > 0)
    .sort((a, b) => b.value / b.cost - a.value / a.cost)
    .slice(0, max);
}

/** Effective cost of a selection, with the shared-file discount. */
export function selectionCost(items: Item[], x: Uint8Array) {
  let c = 0;
  const byFile = new Map<string, number[]>();
  items.forEach((it, i) => {
    if (!x[i]) return;
    c += it.cost;
    if (it.file) (byFile.get(it.file) ?? byFile.set(it.file, []).get(it.file)!).push(it.cost);
  });
  for (const costs of byFile.values()) for (let a = 0; a < costs.length; a++) for (let b = a + 1; b < costs.length; b++) c -= SHARED * Math.min(costs[a], costs[b]);
  return c;
}
const selectionValue = (items: Item[], x: Uint8Array) => items.reduce((a, it, i) => a + (x[i] ? it.value : 0), 0);

export function greedy(items: Item[], budget: number): Uint8Array {
  const x = new Uint8Array(items.length);
  const order = items.map((_, i) => i).sort((a, b) => items[b].value / items[b].cost - items[a].value / items[a].cost);
  for (const i of order) {
    x[i] = 1;
    if (selectionCost(items, x) > budget + 1e-9) x[i] = 0;
  }
  return x;
}

/** Fill any budget left over by the annealer (never removes picks). */
function repairAndFill(items: Item[], x: Uint8Array, budget: number) {
  while (selectionCost(items, x) > budget + 1e-9) {
    let worst = -1;
    for (let i = 0; i < items.length; i++) if (x[i] && (worst < 0 || items[i].value / items[i].cost < items[worst].value / items[worst].cost)) worst = i;
    x[worst] = 0;
  }
  const order = items.map((_, i) => i).sort((a, b) => items[b].value / items[b].cost - items[a].value / items[a].cost);
  for (const i of order) {
    if (x[i]) continue;
    x[i] = 1;
    if (selectionCost(items, x) > budget + 1e-9) x[i] = 0;
  }
  return x;
}

export function anneal(items: Item[], budget: number, opts: { replicas?: number; sweeps?: number; seed?: number; onSample?: (s: { sweep: number; gamma: number; bestValue: number; energy: number }) => void } = {}) {
  const n = items.length;
  const P = opts.replicas ?? 16;
  const sweeps = opts.sweeps ?? 600;
  const rand = mulberry32(opts.seed ?? 7);
  const vMax = Math.max(...items.map((i) => i.value), 1);
  const v = items.map((i) => i.value / vMax);
  const cAvg = items.reduce((a, i) => a + i.cost, 0) / Math.max(1, n);
  const lambda = 4 / (cAvg * cAvg);
  const files = items.map((i) => i.file);
  const T = 0.05;
  const gamma0 = 3;
  // Replica state: spins + running value/cost.
  const xs = Array.from({ length: P }, () => {
    const x = new Uint8Array(n);
    for (let i = 0; i < n; i++) x[i] = rand() < Math.min(0.5, budget / Math.max(1e-9, cAvg * n)) ? 1 : 0;
    return x;
  });
  const val = xs.map((x) => x.reduce((a, b, i) => a + (b ? v[i] : 0), 0));
  const cost = xs.map((x) => selectionCost(items, x));
  const energy = (V: number, C: number) => -V + lambda * Math.max(0, C - budget) ** 2;
  let best = { value: -1, x: new Uint8Array(n) };
  const trace: { sweep: number; gamma: number; bestValue: number; energy: number }[] = [];
  for (let s = 0; s < sweeps; s++) {
    const gamma = Math.max(1e-3, gamma0 * (1 - s / sweeps));
    const jPerp = -(P * T / 2) * Math.log(Math.tanh(gamma / (P * T)));
    for (let k = 0; k < P; k++) {
      const x = xs[k];
      const up = xs[(k + 1) % P];
      const down = xs[(k - 1 + P) % P];
      for (let step = 0; step < n; step++) {
        const i = Math.floor(rand() * n);
        const on = x[i] === 0;
        // Cost delta incl. shared-file discount with currently selected items in the same file.
        let dc = items[i].cost;
        if (files[i]) for (let j = 0; j < n; j++) if (j !== i && x[j] && files[j] === files[i]) dc -= SHARED * Math.min(items[i].cost, items[j].cost);
        const nV = val[k] + (on ? v[i] : -v[i]);
        const nC = cost[k] + (on ? dc : -dc);
        const dProblem = (energy(nV, nC) - energy(val[k], cost[k])) / P;
        const si = x[i] ? 1 : -1;
        const neighbours = (up[i] ? 1 : -1) + (down[i] ? 1 : -1);
        const dQuantum = 2 * jPerp * si * neighbours; // flipping s_i → −s_i changes −J⊥ s_i (s_up + s_down)
        const dE = dProblem + dQuantum;
        if (dE <= 0 || rand() < Math.exp(-dE / T)) {
          x[i] = on ? 1 : 0;
          val[k] = nV;
          cost[k] = nC;
          if (nC <= budget + 1e-9 && nV > best.value) best = { value: nV, x: x.slice() };
        }
      }
    }
    if (s % Math.max(1, Math.floor(sweeps / 60)) === 0 || s === sweeps - 1) {
      const sample = { sweep: s, gamma: Math.round(gamma * 1000) / 1000, bestValue: Math.round(Math.max(0, best.value) * vMax * 100) / 100, energy: Math.round(Math.min(...val.map((V, k) => energy(V, cost[k]))) * vMax * 100) / 100 };
      trace.push(sample);
      opts.onSample?.(sample);
    }
  }
  const x = repairAndFill(items, best.value >= 0 ? best.x : new Uint8Array(n), budget);
  return { x, trace };
}

async function optimizeJob(ctx: JobCtx) {
  const { planId } = ctx.payload as { planId: string };
  const d = db();
  const plan = d.prepare(`SELECT * FROM fix_plans WHERE id = ?`).get(planId) as any;
  const params = json<any>(plan.params, {});
  d.prepare(`UPDATE fix_plans SET status = 'running', job_id = ? WHERE id = ?`).run(ctx.id, planId);
  try {
    const t0 = Date.now();
    const items = loadItems(plan.repository_id, params.effort ?? {});
    if (!items.length) throw new Error("No open detected findings to plan — run an analysis first.");
    ctx.progress(0.05, `Annealing over ${items.length} findings`);
    let lastEmit = 0;
    const { x, trace } = anneal(items, params.budgetHours, {
      replicas: params.replicas ?? 16, sweeps: params.sweeps ?? 600, seed: params.seed ?? 7,
      onSample: (smp) => {
        if (Date.now() - lastEmit > 40) {
          lastEmit = Date.now();
          publish(plan.workspace_id, { type: "quantum", planId, ...smp });
        }
        ctx.progress(0.05 + 0.9 * (smp.sweep / (params.sweeps ?? 600)), `Sweep ${smp.sweep}, Γ=${smp.gamma}`);
      },
    });
    const g = greedy(items, params.budgetHours);
    const pick = (sel: Uint8Array) => ({ value: Math.round(selectionValue(items, sel) * 100) / 100, cost: Math.round(selectionCost(items, sel) * 100) / 100, count: sel.reduce((a, b) => a + b, 0) });
    const sqa = pick(x);
    const base = pick(g);
    const useSqa = sqa.value >= base.value;
    const chosen = useSqa ? x : g;
    const result = {
      method: "Simulated quantum annealing (path-integral Monte Carlo, classical hardware)",
      candidates: items.length,
      budgetHours: params.budgetHours,
      sqa, greedy: base,
      improvementPct: base.value > 0 ? Math.round(((sqa.value - base.value) / base.value) * 1000) / 10 : null,
      chosen: useSqa ? "sqa" : "greedy",
      selected: items.filter((_, i) => chosen[i]).map((it) => ({ ...it })),
      skipped: items.filter((_, i) => !chosen[i]).slice(0, 50).map((it) => ({ ...it })),
      trace,
      effort: { ...DEFAULT_EFFORT, ...(params.effort ?? {}) },
      ms: Date.now() - t0,
    };
    d.prepare(`UPDATE fix_plans SET status = 'completed', result = ?, finished_at = ? WHERE id = ?`).run(JSON.stringify(result), now(), planId);
    publish(plan.workspace_id, { type: "quantum", planId, done: true });
    const chosenStats = useSqa ? sqa : base;
    notify({ workspaceId: plan.workspace_id, userId: plan.created_by ?? undefined, kind: "optimizer", title: `Fix plan ready: ${chosenStats.count} findings, ${chosenStats.cost}h of ${params.budgetHours}h budget`, link: `/app/optimizer?plan=${planId}` });
    return { selected: result.selected.length, value: chosenStats.value };
  } catch (e: any) {
    d.prepare(`UPDATE fix_plans SET status = 'failed', error = ?, finished_at = ? WHERE id = ?`).run(String(e.message).slice(0, 500), now(), planId);
    publish(plan.workspace_id, { type: "quantum", planId, done: true, error: e.message });
    throw e;
  }
}

registerHandler("quantum.optimize", optimizeJob);
