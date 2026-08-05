/** Protocol-neutral semantic contracts shared by editor adapters. */

export interface SemanticDocument {
  readonly uri: string;
  readonly languageId: string;
  getText(range?: SemanticRange): string;
  offsetAt(position: SemanticPosition): number;
  positionAt(offset: number): SemanticPosition;
}

export interface SemanticPosition {
  readonly line: number;
  readonly character: number;
}

export interface SemanticRange {
  readonly start: SemanticPosition;
  readonly end: SemanticPosition;
}

export interface SemanticLocation {
  readonly uri: string;
  readonly range: SemanticRange;
}

export interface SemanticDiagnostic {
  readonly severity: 1 | 2 | 3 | 4;
  readonly message: string;
  readonly range: SemanticRange;
  readonly source?: string;
}

export interface SemanticCompletionItem {
  readonly label: string;
  readonly kind?: number;
}

export interface SemanticHover {
  readonly contents: { readonly kind: 'markdown'; readonly value: string };
  readonly range?: SemanticRange;
}

export interface SemanticTextEdit {
  readonly range: SemanticRange;
  readonly newText: string;
}

export interface SemanticWorkspaceEdit {
  readonly changes?: Readonly<Record<string, readonly SemanticTextEdit[]>>;
}

export interface SemanticSymbolInformation {
  readonly name: string;
  readonly kind: number;
  readonly location: SemanticLocation;
  readonly containerName?: string;
}

export const SemanticDiagnosticSeverity = Object.freeze({
  Error: 1,
  Warning: 2,
  Information: 3,
  Hint: 4,
});
export const SemanticCompletionKind = Object.freeze({
  Property: 10,
  Value: 12,
  EnumMember: 20,
  Reference: 18,
});
export const SemanticSymbolKind = Object.freeze({ Method: 6, Event: 23 });
