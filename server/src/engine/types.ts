export type Severity = "critical" | "high" | "medium" | "low" | "info";
export type Confidence = "high" | "medium" | "low";
export type FindingSource = "bug" | "security" | "secret" | "dependency" | "performance" | "debt" | "review";

export interface RawFinding {
  source: FindingSource;
  tool: string;
  rule_id: string;
  title: string;
  category: string;
  severity: Severity;
  confidence: Confidence;
  file_path?: string | null;
  line?: number | null;
  end_line?: number | null;
  snippet?: string | null;
  evidence: string;
  explanation: string;
  impact: string;
  recommendation: string;
  verification: string;
  related?: string[];
  suggested_patch?: string | null;
  origin?: "detected" | "ai_hypothesis";
}

export interface ParsedSymbol {
  name: string;
  kind: "function" | "method" | "class" | "interface" | "type" | "variable" | "route" | "model" | "component";
  parent?: string | null;
  line: number;
  end_line: number;
  signature?: string;
  exported: boolean;
  complexity: number;
  meta?: Record<string, unknown>;
}

export interface ParsedImport {
  spec: string;
  names: string[];
  line: number;
}

export interface ParsedCall {
  caller: string | null;
  callee: string;
  line: number;
}

export interface ParseResult {
  symbols: ParsedSymbol[];
  imports: ParsedImport[];
  calls: ParsedCall[];
  findings: RawFinding[];
  complexity: number;
  maxFunctionLines: number;
  parsed: boolean;
}

export interface IndexedFile {
  id: string;
  path: string;
  abs: string;
  language: string | null;
  size: number;
  loc: number;
  content: string;
  isTest: boolean;
}
