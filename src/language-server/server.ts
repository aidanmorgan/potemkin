#!/usr/bin/env node

import * as path from 'node:path';

import {
  createConnection,
  ProposedFeatures,
  TextDocuments,
  type CompletionParams,
  type DefinitionParams,
  type HoverParams,
  type InitializeParams,
  type InitializeResult,
  type ReferenceParams,
  type RenameParams,
  type WorkspaceSymbolParams,
  type CompletionItem,
  type WorkspaceEdit,
  type SymbolInformation,
} from 'vscode-languageserver/node.js';
import { TextDocument } from 'vscode-languageserver-textdocument';

import { PotemkinLanguageService, type AuthoringLanguage } from './service.js';

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
  return [...(await service.completions(document, params.position))] as CompletionItem[];
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
  return (await service.rename(document, params.position, params.newName)) as
    | WorkspaceEdit
    | undefined;
});

connection.onHover(async (params: HoverParams) => {
  const document = documents.get(params.textDocument.uri);
  if (document === undefined || service === undefined) return undefined;
  return service.hover(document, params.position);
});

connection.onWorkspaceSymbol(async (params: WorkspaceSymbolParams) => {
  if (service === undefined) return [];
  return [...(await service.workspaceSymbols(params.query))] as SymbolInformation[];
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
    ? (value as Record<string, unknown>)
    : {};
}
