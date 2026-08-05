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

export type DiagnosticSeverity = 'error' | 'warning' | 'information';

export interface Diagnostic {
  readonly code: string;
  readonly severity: DiagnosticSeverity;
  readonly message: string;
  readonly location?: SourceLocation;
}
