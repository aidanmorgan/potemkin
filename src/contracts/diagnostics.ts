/** Source positions and diagnostics shared by source adapters and tooling. */
export interface SourcePosition {
  readonly line: number;
  readonly column: number;
  readonly offset?: number;
}

export interface SourceLocation {
  readonly sourcePath: string;
  readonly start?: SourcePosition;
  readonly end?: SourcePosition;
}

export const DiagnosticSeverity = {
  Error: 'error',
  Warning: 'warning',
  Information: 'information',
} as const;

export type DiagnosticSeverity = (typeof DiagnosticSeverity)[keyof typeof DiagnosticSeverity];

export interface Diagnostic {
  readonly code: string;
  readonly severity: DiagnosticSeverity;
  readonly message: string;
  readonly location?: SourceLocation;
}
