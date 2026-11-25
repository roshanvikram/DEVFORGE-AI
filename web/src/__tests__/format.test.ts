import { describe, it, expect } from "vitest";
import { timeAgo, num, pct, duration, durationBetween, titleCase, usd } from "../lib/format";

describe("format helpers", () => {
  it("formats relative times", () => {
    expect(timeAgo(null)).toBe("—");
    expect(timeAgo(new Date().toISOString())).toBe("just now");
    expect(timeAgo(new Date(Date.now() - 5 * 60_000).toISOString())).toBe("5m ago");
    expect(timeAgo(new Date(Date.now() - 3 * 3_600_000).toISOString())).toBe("3h ago");
    expect(timeAgo(new Date(Date.now() - 2 * 86_400_000).toISOString())).toBe("2d ago");
  });
  it("never invents a value for missing numbers", () => {
    expect(num(null)).toBe("—");
    expect(num(undefined)).toBe("—");
    expect(num(0)).toBe("0");
    expect(pct(null)).toBe("—");
    expect(pct(83.4)).toBe("83%");
    expect(usd(null)).toBe("—");
    expect(usd(0.0123)).toBe("$0.012");
    expect(usd(12.5)).toBe("$12.50");
  });
  it("formats durations across units", () => {
    expect(duration(null)).toBe("—");
    expect(duration(250)).toBe("250ms");
    expect(duration(3200)).toBe("3.2s");
    expect(duration(125_000)).toBe("2m 5s");
    expect(duration(2 * 3_600_000 + 5 * 60_000)).toBe("2h 5m");
    expect(duration(3 * 86_400_000 + 4 * 3_600_000)).toBe("3d 4h");
    expect(durationBetween("2026-01-01T00:00:00Z", "2026-01-01T00:00:01.500Z")).toBe("1.5s");
    expect(durationBetween(null, "2026-01-01T00:00:00Z")).toBe("—");
  });
  it("title-cases identifiers", () => {
    expect(titleCase("repo_import-done")).toBe("Repo Import Done");
  });
});
