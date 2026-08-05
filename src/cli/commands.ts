export interface PotemkinCommand {
  readonly name: string;
  readonly usage: string;
  readonly run: (argv: readonly string[]) => Promise<void>;
}

const commands: readonly PotemkinCommand[] = [
  {
    name: 'generate-types',
    usage: 'generate-types [potemkin.yml] [--watch] [--output gen-src]',
    run: async (argv) => {
      const { parseGenerateTypesArguments, runGenerateTypes } = await import('./generate-types.js');
      await runGenerateTypes(parseGenerateTypesArguments(argv));
    },
  },
  {
    name: 'language-server',
    usage: 'language-server',
    run: async () => {
      await import('../language-server/server.js');
    },
  },
  {
    name: 'conformance',
    usage: 'conformance [--example crm] [--layer negative|positive]',
    run: async (argv) => {
      const { runConformance } = await import('../conformance/cli.js');
      await runConformance(argv);
    },
  },
  {
    name: 'server',
    usage: 'server [--config potemkin.yml] [--port 3000] [--host 127.0.0.1]',
    run: async (argv) => {
      const { runServer } = await import('./server.js');
      await runServer(argv);
    },
  },
  {
    name: 'lint',
    usage: 'lint <potemkin.yml | directory>',
    run: async (argv) => {
      const { runLint } = await import('./lint.js');
      await runLint(argv);
    },
  },
  {
    name: 'export-examples',
    usage: 'export-examples <example-dir | potemkin.yml> [--check]',
    run: async (argv) => {
      const { runExportExamples } = await import('./export-examples.js');
      await runExportExamples(argv);
    },
  },
];

export function availableCommands(): readonly PotemkinCommand[] {
  return commands;
}

export async function runCli(argv: readonly string[]): Promise<void> {
  const [name, ...arguments_] = argv;
  const command = commands.find((candidate) => candidate.name === name);
  if (command === undefined) {
    throw new Error(`usage: potemkin ${commands.map((candidate) => candidate.usage).join(' | ')}`);
  }
  try {
    await command.run(arguments_);
  } catch (error) {
    if (error instanceof Error && error.name === 'ConformanceHelpRequested') {
      process.stdout.write(`${error.message}\n`);
      return;
    }
    throw error;
  }
}
