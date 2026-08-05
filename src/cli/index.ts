import { availableCommands, runCli } from './commands.js';

export { availableCommands, runCli };

if (process.argv[1]?.endsWith('index.js') || process.argv[1]?.endsWith('index.ts')) {
  void runCli(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
