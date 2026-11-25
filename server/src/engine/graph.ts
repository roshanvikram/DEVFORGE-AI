/** Graph algorithms over the file-level import graph. */

export function stronglyConnected(nodes: string[], adj: Map<string, string[]>): string[][] {
  let index = 0;
  const idx = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const out: string[][] = [];

  // Iterative Tarjan to avoid recursion limits on large repos.
  for (const start of nodes) {
    if (idx.has(start)) continue;
    const work: { v: string; i: number }[] = [{ v: start, i: 0 }];
    idx.set(start, index);
    low.set(start, index);
    index++;
    stack.push(start);
    onStack.add(start);
    while (work.length) {
      const top = work[work.length - 1];
      const succ = adj.get(top.v) ?? [];
      if (top.i < succ.length) {
        const w = succ[top.i++];
        if (!idx.has(w)) {
          idx.set(w, index);
          low.set(w, index);
          index++;
          stack.push(w);
          onStack.add(w);
          work.push({ v: w, i: 0 });
        } else if (onStack.has(w)) {
          low.set(top.v, Math.min(low.get(top.v)!, idx.get(w)!));
        }
      } else {
        work.pop();
        if (work.length) {
          const parent = work[work.length - 1].v;
          low.set(parent, Math.min(low.get(parent)!, low.get(top.v)!));
        }
        if (low.get(top.v) === idx.get(top.v)) {
          const comp: string[] = [];
          let w: string;
          do {
            w = stack.pop()!;
            onStack.delete(w);
            comp.push(w);
          } while (w !== top.v);
          if (comp.length > 1 || (adj.get(top.v) ?? []).includes(top.v)) out.push(comp);
        }
      }
    }
  }
  return out;
}

/** Find one concrete cycle path inside an SCC for display (A -> B -> C -> A). */
export function cyclePath(comp: string[], adj: Map<string, string[]>): string[] {
  const set = new Set(comp);
  const start = comp[0];
  const prev = new Map<string, string>();
  const queue = [start];
  const seen = new Set([start]);
  while (queue.length) {
    const v = queue.shift()!;
    for (const w of adj.get(v) ?? []) {
      if (!set.has(w)) continue;
      if (w === start) {
        const path = [start];
        let cur = v;
        const back: string[] = [];
        while (cur !== start) {
          back.push(cur);
          cur = prev.get(cur)!;
        }
        return [...path, ...back.reverse(), start];
      }
      if (!seen.has(w)) {
        seen.add(w);
        prev.set(w, v);
        queue.push(w);
      }
    }
  }
  return [...comp, comp[0]];
}

/** Shortest path between two nodes (BFS) for "highlight path" in the architecture explorer. */
export function shortestPath(from: string, to: string, adj: Map<string, string[]>): string[] | null {
  const prev = new Map<string, string>();
  const queue = [from];
  const seen = new Set([from]);
  while (queue.length) {
    const v = queue.shift()!;
    if (v === to) {
      const path = [to];
      let cur = to;
      while (cur !== from) {
        cur = prev.get(cur)!;
        path.unshift(cur);
      }
      return path;
    }
    for (const w of adj.get(v) ?? []) if (!seen.has(w)) { seen.add(w); prev.set(w, v); queue.push(w); }
  }
  return null;
}
