const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');
const { LanguageClient, TransportKind } = require('vscode-languageclient/node');

let client;

function activate(context) {
  const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const settings = vscode.workspace.getConfiguration('potemkin');
  const configuredCommand = settings.get('languageServer.command', '');
  const localServer =
    workspace === undefined
      ? undefined
      : path.join(
          workspace,
          'node_modules',
          '.bin',
          process.platform === 'win32'
            ? 'potemkin-language-server.cmd'
            : 'potemkin-language-server',
        );
  const serverOptions =
    localServer !== undefined && fs.existsSync(localServer) && configuredCommand === ''
      ? { command: localServer, transport: TransportKind.stdio }
      : {
          command:
            configuredCommand ||
            (process.platform === 'win32'
              ? 'potemkin-language-server.cmd'
              : 'potemkin-language-server'),
          transport: TransportKind.stdio,
        };
  const clientOptions = {
    documentSelector: [
      { scheme: 'file', language: 'yaml' },
      { scheme: 'file', language: 'typescript' },
      { scheme: 'file', language: 'typescriptreact' },
    ],
    initializationOptions: {
      configPath: settings.get('configPath', 'potemkin.yml'),
      ...(workspace === undefined ? {} : { workspacePath: workspace }),
    },
  };
  client = new LanguageClient('potemkin', 'Potemkin Language Server', serverOptions, clientOptions);
  context.subscriptions.push(client.start());
}

async function deactivate() {
  if (client !== undefined) await client.stop();
}

module.exports = { activate, deactivate };
