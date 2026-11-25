/**
 * Health-score presentation rules. The weights must match the server's healthScore()
 * (server/src/services/metrics.ts); a unit test guards against drift.
 */
export const DIMENSIONS: { key: string; label: string; weight: number; hint: string }[] = [
  { key: "security", label: "Security", weight: 35, hint: "security, secret & dependency findings" },
  { key: "reliability", label: "Reliability", weight: 30, hint: "bug findings" },
  { key: "maintainability", label: "Maintainability", weight: 25, hint: "technical-debt findings" },
  { key: "performance", label: "Performance", weight: 10, hint: "performance findings" },
];

export function gradeFor(score: number | null) {
  if (score == null) return { grade: "—", label: "Not analysed", color: "#C9C6BD", tone: "neutral" as const };
  if (score >= 90) return { grade: "A", label: "Excellent", color: "#23966A", tone: "success" as const };
  if (score >= 80) return { grade: "B", label: "Good", color: "#5FA36B", tone: "success" as const };
  if (score >= 65) return { grade: "C", label: "Fair", color: "#D99A28", tone: "amber" as const };
  if (score >= 45) return { grade: "D", label: "At risk", color: "#E07A3A", tone: "danger" as const };
  return { grade: "F", label: "Critical", color: "#D94C4C", tone: "danger" as const };
}
