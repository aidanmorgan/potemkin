#!/usr/bin/env node

import * as path from 'node:path';

import {
  createConnection,
  ProposedFeatures,
  TextDocuments,
  type CompletionParams,
  type CompletionItem,
  CompletionItemKind,
  type DefinitionParams,
  type HoverParams,
  type InitializeParams,
  type InitializeResult,
  type ReferenceParams,
  type RenameParams,
  type WorkspaceSymbolParams,
  type SymbolInformation,
  SymbolKind,
  type TextEdit,
  type WorkspaceEdit,
} from 'vscode-languageserver/node.js';
import { TextDocument } from 'vscode-languageserver-textdocument';

import { PotemkinLanguageService, type AuthoringLanguage } from './service.js';
import type {
  SemanticCompletionItem,
  SemanticSymbolInformation,
  SemanticWorkspaceEdit,
} from './contracts.js';

const connection = createConnection(ProposedFeatures.all, process.stdin, process.stdout);
const documents = new TextDocuments(TextDocument);
let service: PotemkinLanguageService | undefined;

connection.onInitialize((params: InitializeParams): InitializeResult => {
  const workspacePath = workspacePathFrom(params);
  const initialization = asRecord(params.initializationOptions);
  const configPath =
    typeof initialization.configPath === 'string' ? initialization.configPath : undefined;
  const outputDirectory =
    typeof initialization.outputDirectory === 'string'
      ? path.resolve(process.cwd(), initialization.outputDirectory)
      : path.join(process.cwd(), '.potemkin');
  service = new PotemkinLanguageService({ workspacePath, configPath, outputDirectory });
  return {
    capabilities: {
      textDocumentSync: { openClose: true, change: 1, save: { includeText: true } },
      completionProvider: { triggerCharacters: [':', '"', "'"] },
      definitionProvider: true,
      referencesProvider: true,
      renameProvider: true,
      hoverProvider: true,
      workspaceSymbolProvider: true,
    },
    serverInfo: { name: 'Potemkin Language Server', version: '0.1.0' },
  };
});

documents.onDidOpen((event) => {
  service?.open(event.document, languageFor(event.document.uri, event.document.languageId));
  void publishAll();
});

documents.onDidChangeContent((event) => {
  const document = event.document;
  service?.change(document, languageFor(document.uri, document.languageId));
  void publishAll();
});

documents.onDidClose((event) => {
  service?.close(event.document.uri);
  connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] });
  void publishAll();
});

connection.onCompletion(async (params: CompletionParams) => {
  const document = documents.get(params.textDocument.uri);
  if (document === undefined || service === undefined) return [];
  return toCompletionItems(await service.completions(document, params.position));
});

connection.onDefinition(async (params: DefinitionParams) => {
  const document = documents.get(params.textDocument.uri);
  if (document === undefined || service === undefined) return undefined;
  return service.definition(document, params.position);
});

connection.onReferences(async (params: ReferenceParams) => {
  const document = documents.get(params.textDocument.uri);
  if (document === undefined || service === undefined) return [];
  return [...(await service.references(document, params.position))];
});

connection.onRenameRequest(async (params: RenameParams) => {
  const document = documents.get(params.textDocument.uri);
  if (document === undefined || service === undefined) return undefined;
  return toWorkspaceEdit(await service.rename(document, params.position, params.newName));
});

connection.onHover(async (params: HoverParams) => {
  const document = documents.get(params.textDocument.uri);
  if (document === undefined || service === undefined) return undefined;
  return service.hover(document, params.position);
});

connection.onWorkspaceSymbol(async (params: WorkspaceSymbolParams) => {
  if (service === undefined) return [];
  return toSymbolInformation(await service.workspaceSymbols(params.query));
});

connection.onShutdown(async () => {
  await service?.dispose();
});

documents.listen(connection);
connection.listen();

async function publishAll(): Promise<void> {
  if (service === undefined) return;
  await Promise.all(
    documents.all().map(async (document) => {
      connection.sendDiagnostics({
        uri: document.uri,
        diagnostics: [...((await service?.diagnostics(document)) ?? [])],
      });
    }),
  );
}

function workspacePathFrom(params: InitializeParams): string {
  const root = params.rootUri ?? params.workspaceFolders?.[0]?.uri;
  if (root?.startsWith('file:')) return decodeURIComponent(new URL(root).pathname);
  return process.cwd();
}

function languageFor(uri: string, languageId: string): AuthoringLanguage {
  if (languageId === 'typescript' || languageId === 'typescriptreact' || /\.tsx?$/.test(uri)) {
    return 'typescript';
  }
  return 'yaml';
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};
}

function toCompletionItems(items: readonly SemanticCompletionItem[]): CompletionItem[] {
  return items.map((item) => ({
    label: item.label,
    ...(item.kind !== undefined && isCompletionItemKind(item.kind) ? { kind: item.kind } : {}),
  }));
}

function isCompletionItemKind(value: number): value is CompletionItemKind {
  return Object.values(CompletionItemKind).some((candidate) => candidate === value);
}

function toWorkspaceEdit(edit: SemanticWorkspaceEdit | undefined): WorkspaceEdit | undefined {
  if (edit === undefined) return undefined;
  if (edit.changes === undefined) return {};
  const changes: Record<string, TextEdit[]> = {};
  for (const [uri, edits] of Object.entries(edit.changes)) {
    changes[uri] = edits.map((textEdit) => ({
      range: {
        start: textEdit.range.start,
        end: textEdit.range.end,
      },
      newText: textEdit.newText,
    }));
  }
  return { changes };
}

function toSymbolInformation(symbols: readonly SemanticSymbolInformation[]): SymbolInformation[] {
  return symbols.map((symbol) => ({
    name: symbol.name,
    kind: isSymbolKind(symbol.kind) ? symbol.kind : SymbolKind.String,
    location: {
      uri: symbol.location.uri,
      range: {
        start: symbol.location.range.start,
        end: symbol.location.range.end,
      },
    },
    ...(symbol.containerName === undefined ? {} : { containerName: symbol.containerName }),
  }));
}

function isSymbolKind(value: number): value is SymbolKind {
  return Object.values(SymbolKind).some((candidate) => candidate === value);
}
