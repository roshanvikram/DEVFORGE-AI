import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { gradeFor, DIMENSIONS } from "../lib/grade";

describe("health grade", () => {
  it("maps scores to grades at the documented thresholds", () => {
    expect(gradeFor(null).grade).toBe("—");
    expect(gradeFor(100).grade).toBe("A");
    expect(gradeFor(90).grade).toBe("A");
    expect(gradeFor(89).grade).toBe("B");
    expect(gradeFor(80).grade).toBe("B");
    expect(gradeFor(65).grade).toBe("C");
    expect(gradeFor(64).grade).toBe("D");
    expect(gradeFor(45).grade).toBe("D");
    expect(gradeFor(44).grade).toBe("F");
    expect(gradeFor(0).grade).toBe("F");
  });
  it("shows the same dimension weights the server uses to compute the score", () => {
    expect(DIMENSIONS.reduce((a, d) => a + d.weight, 0)).toBe(100);
    const src = fs.readFileSync(path.resolve(process.cwd(), "../server/src/services/metrics.ts"), "utf8");
    for (const d of DIMENSIONS) {
      const m = src.match(new RegExp(`breakdown\\.${d.key} \\* ([0-9.]+)`));
      expect(m, `weight for ${d.key} in metrics.ts`).toBeTruthy();
      expect(Math.round(Number(m![1]) * 100)).toBe(d.weight);
    }
  });
});
