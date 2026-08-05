import { availableCommands, runCli } from '../../../src/cli/commands.js';

describe('CLI command registry', () => {
  it('owns the supported process commands in one registry', () => {
    expect(availableCommands().map((command) => command.name)).toEqual([
      'generate-types',
      'language-server',
      'conformance',
      'server',
      'lint',
      'export-examples',
    ]);
    expect(availableCommands().every((command) => command.usage.length > 0)).toBe(true);
  });

  it('dispatches conformance help without booting a project', async () => {
    const write = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await runCli(['conformance', '--help']);
      expect(write).toHaveBeenCalledWith(expect.stringContaining('Usage:'));
    } finally {
      write.mockRestore();
    }
  });

  it('rejects commands outside the registry', async () => {
    await expect(runCli(['unknown-command'])).rejects.toThrow('usage: potemkin');
  });
});
