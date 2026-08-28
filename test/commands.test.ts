import { describe, expect, test } from 'bun:test';

import {
  BUILT_IN_COMMANDS,
  ShellCommandError,
  commandHint,
  expandCommandTemplate,
  executeShellCommands,
  findBuiltInCommand,
  findCommand,
  parseCommandText,
  substituteArguments,
  toAvailableCommands,
  validateRequiredArguments,
  type BridgeCommand,
  type CommandsData,
} from '../src/commands';

const basicCommand: BridgeCommand = {
  name: 'test',
  description: 'Run tests',
  arguments: [{ description: 'suite to run' }],
  template: 'Run the {{1}} suite',
};

const commands: CommandsData = {
  customCommands: [basicCommand],
  extensionCommands: [{ name: 'summarize', description: 'Summarize the conversation', arguments: [] }],
};

describe('parseCommandText', () => {
  test('parses name and args', () => {
    expect(parseCommandText('/web agent client protocol')).toEqual({
      name: 'web',
      args: ['agent', 'client', 'protocol'],
    });
  });

  test('parses a command with no args', () => {
    expect(parseCommandText('/plan')).toEqual({ name: 'plan', args: [] });
  });

  test('collapses repeated whitespace between args', () => {
    expect(parseCommandText('/cmd  a    b ')).toEqual({ name: 'cmd', args: ['a', 'b'] });
  });

  test('keeps nested command names intact', () => {
    expect(parseCommandText('/git:commit fix')).toEqual({ name: 'git:commit', args: ['fix'] });
  });

  test('returns null for plain text', () => {
    expect(parseCommandText('hello world')).toBeNull();
  });

  test('returns null for a bare slash', () => {
    expect(parseCommandText('/')).toBeNull();
    expect(parseCommandText('/ ')).toBeNull();
  });
});

describe('toAvailableCommands', () => {
  test('maps custom and extension commands plus built-ins, sorted by name', () => {
    const commandsData: CommandsData = {
      customCommands: [{ name: 'zeta', description: 'Last one', arguments: [] }],
      extensionCommands: [{ name: 'alpha', description: 'First one', arguments: [] }],
    };
    expect(toAvailableCommands(commandsData)).toEqual([
      { name: 'alpha', description: 'First one' },
      { name: 'compact', description: 'Compact the conversation', input: { hint: '1: custom compact instructions (optional)' } },
      { name: 'handoff', description: 'Hand off the conversation with a focus note', input: { hint: '1: focus note (optional)' } },
      { name: 'load', description: 'Load a task (by id or the #number shown in /tasks)', input: { hint: '1: task id or task number' } },
      { name: 'new', description: 'Start a new task', input: { hint: '1: task name (optional)' } },
      { name: 'smart-compact', description: 'Compact the conversation with an AI-generated summary' },
      { name: 'tasks', description: 'List the tasks for the current project' },
      { name: 'zeta', description: 'Last one' },
    ]);
  });

  test('does not advertise built-in aliases', () => {
    const names = toAvailableCommands({ customCommands: [], extensionCommands: [] }).map((c) => c.name);
    expect(names).not.toContain('hand-off');
  });

  test('adds an input hint when the command declares arguments', () => {
    const available = toAvailableCommands(commands);
    const testCommand = available.find((c) => c.name === 'test');
    expect(testCommand).toMatchObject({
      name: 'test',
      description: 'Run tests',
      input: { hint: '1: suite to run' },
    });
  });

  test('omits the input when there are no arguments', () => {
    const available = toAvailableCommands(commands);
    const summarize = available.find((c) => c.name === 'summarize');
    expect(summarize).toEqual({ name: 'summarize', description: 'Summarize the conversation' });
    expect('input' in summarize!).toBe(false);
  });
});

describe('commandHint', () => {
  test('describes required and optional arguments', () => {
    const command: BridgeCommand = {
      name: 'x',
      description: 'X',
      arguments: [
        { description: 'file', required: false },
        { description: 'message' },
      ],
    };
    expect(commandHint(command)).toBe('1: file (optional), 2: message');
  });

  test('returns undefined with no arguments', () => {
    expect(commandHint({ name: 'x', description: 'X', arguments: [] })).toBeUndefined();
  });
});

describe('findCommand', () => {
  test('prefers custom over extension commands', () => {
    const data: CommandsData = {
      customCommands: [{ name: 'dup', description: 'custom', arguments: [] }],
      extensionCommands: [{ name: 'dup', description: 'extension', arguments: [] }],
    };
    expect(findCommand(data, 'dup')?.description).toBe('custom');
  });

  test('returns undefined for unknown commands', () => {
    expect(findCommand(commands, 'nope')).toBeUndefined();
  });
});

describe('findBuiltInCommand', () => {
  test('finds every built-in command', () => {
    for (const builtIn of BUILT_IN_COMMANDS) {
      expect(findBuiltInCommand(builtIn.name)?.name).toBe(builtIn.name);
    }
  });

  test('resolves the hand-off alias to handoff', () => {
    expect(findBuiltInCommand('hand-off')?.name).toBe('handoff');
  });

  test('returns undefined for unknown names', () => {
    expect(findBuiltInCommand('console')).toBeUndefined();
  });
});

describe('validateRequiredArguments', () => {
  test('passes when required arguments are supplied', () => {
    expect(validateRequiredArguments(basicCommand, ['unit'])).toBeUndefined();
  });

  test('reports missing required arguments', () => {
    const error = validateRequiredArguments(basicCommand, []);
    expect(error).toContain("Not enough arguments for command 'test'");
    expect(error).toContain('1: suite to run');
  });

  test('allows omitted optional arguments', () => {
    const command: BridgeCommand = {
      name: 'x',
      description: 'X',
      arguments: [{ description: 'extra', required: false }],
      template: 'nothing',
    };
    expect(validateRequiredArguments(command, [])).toBeUndefined();
  });
});

describe('substituteArguments', () => {
  test('replaces positional placeholders', () => {
    expect(substituteArguments('Fix {{1}} and {{2}}', ['a', 'b'], [])).toBe('Fix a and b');
  });

  test('replaces {{ARGUMENTS}} with all args joined', () => {
    expect(substituteArguments('Use: {{ARGUMENTS}}', ['a', 'b'], [])).toBe('Use: a b');
  });

  test('drops unreplaced optional placeholders', () => {
    const result = substituteArguments('{{1}} {{2}}', ['a'], [{ description: 'x' }, { description: 'y', required: false }]);
    expect(result).toBe('a ');
  });

  test('leaves unreplaced required placeholders intact', () => {
    const result = substituteArguments('{{1}} {{2}}', ['a'], [{ description: 'x' }]);
    expect(result).toBe('a {{2}}');
  });
});

describe('executeShellCommands', () => {
  test('runs !shell lines and wraps output', async () => {
    const result = await executeShellCommands('Scope: {{1}}\n!echo tiny notice', '/');
    expect(result).toContain('<custom-command-bash>');
    expect(result).toContain('<command>echo tiny notice</command>');
    expect(result).toContain('tiny notice');
    expect(result).toContain('</custom-command-bash>');
  });

  test('leaves a bare ! line untouched', async () => {
    await expect(executeShellCommands('hello\n!')).resolves.toBe('hello\n!');
  });

  test('throws ShellCommandError on a failing command', async () => {
    await expect(executeShellCommands('!false')).rejects.toBeInstanceOf(ShellCommandError);
    await expect(executeShellCommands('!nonsense-command-xyz')).rejects.toBeInstanceOf(ShellCommandError);
  });
});

describe('expandCommandTemplate', () => {
  test('substitutes arguments and executes shell lines', async () => {
    const command: BridgeCommand = {
      name: 'sneak',
      description: 'Show a message',
      arguments: [{ description: 'word' }],
      template: 'Tell me: {{1}}\n!echo hi',
    };
    const expanded = await expandCommandTemplate(command, ['secret'], '/');
    expect(expanded).toContain('Tell me: secret');
    expect(expanded).toContain('<output>');
    expect(expanded).toContain('hi');
  });

  test('throws when the command has no template', async () => {
    await expect(expandCommandTemplate({ name: 'x', description: 'X', arguments: [] }, [])).rejects.toThrow(
      'has no template',
    );
  });
});