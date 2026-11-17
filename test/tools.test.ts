import { describe, expect, test } from 'bun:test';

import {
  asCallToolResult,
  buildToolCallContentArray,
  contentBlocksToPrompt,
  extractFilePath,
  formatToolTitle,
  inferToolKind,
  isToolFailed,
  parseToolArgs,
  parseToolResponse,
  stripAnsi,
  toolResultText,
} from '../src/tools';

describe('inferToolKind', () => {
  test("maps AiderDesk's own tool names", () => {
    expect(inferToolKind('file_read')).toBe('read');
    expect(inferToolKind('read_file')).toBe('read');
    expect(inferToolKind('file_edit')).toBe('edit');
    expect(inferToolKind('edit_block')).toBe('edit');
    expect(inferToolKind('file_write')).toBe('edit');
    expect(inferToolKind('write_file')).toBe('edit');
    expect(inferToolKind('file_delete')).toBe('delete');
    expect(inferToolKind('file_move')).toBe('move');
    expect(inferToolKind('execute_command')).toBe('execute');
    expect(inferToolKind('bash')).toBe('execute');
    // A sandbox that runs code is what ACP calls `execute'.
    expect(inferToolKind('code_mode')).toBe('execute');
    expect(inferToolKind('grep')).toBe('search');
    expect(inferToolKind('glob')).toBe('search');
    expect(inferToolKind('search_files')).toBe('search');
    expect(inferToolKind('semantic_search')).toBe('search');
    expect(inferToolKind('fetch')).toBe('fetch');
    expect(inferToolKind('think')).toBe('think');
  });

  test('maps MCP tool names by whole word', () => {
    expect(inferToolKind('desktop.read_file')).toBe('read');
    expect(inferToolKind('brain_search_vault')).toBe('search');
    expect(inferToolKind('todo.set_items')).toBe('other');
    expect(inferToolKind('weird_tool')).toBe('other');
  });

  test('does not read kinds out of the middle of a word', () => {
    // A substring match read these as read/execute/edit.
    expect(inferToolKind('budget')).toBe('other');
    expect(inferToolKind('prune')).toBe('other');
    expect(inferToolKind('credit')).toBe('other');
  });
});

describe('parseToolArgs', () => {
  test('passes objects through', () => {
    expect(parseToolArgs({ filePath: '/a' })).toEqual({ filePath: '/a' });
  });

  test('parses JSON strings', () => {
    expect(parseToolArgs('{"filePath":"/a","mode":"edit"}')).toEqual({ filePath: '/a', mode: 'edit' });
  });

  test('returns empty object for invalid input', () => {
    expect(parseToolArgs('not json')).toEqual({});
    expect(parseToolArgs(undefined)).toEqual({});
    expect(parseToolArgs(42)).toEqual({});
  });
});

describe('extractFilePath', () => {
  test('prefers filePath, then file_path, then path', () => {
    expect(extractFilePath('file_read', { filePath: '/a', path: '/b' })).toBe('/a');
    expect(extractFilePath('read_file', { file_path: '/a', path: '/b' })).toBe('/a');
    expect(extractFilePath('file_read', { path: '/b' })).toBe('/b');
    expect(extractFilePath('bash', { command: 'ls' })).toBeUndefined();
  });
});

describe('formatToolTitle', () => {
  test('formats specific tools', () => {
    expect(formatToolTitle('grep', { searchTerm: 'foo', filePattern: '*.ts' })).toBe('Grep: "foo" in *.ts');
    expect(formatToolTitle('bash', { command: 'ls -la' })).toBe('Bash: ls -la');
    expect(formatToolTitle('file_read', { filePath: '/a' })).toBe('Read: /a');
    expect(formatToolTitle('unknown_tool', {})).toBe('Unknown_tool');
  });

  test('truncates long inputs with a single ellipsis', () => {
    const title = formatToolTitle('bash', { command: 'x'.repeat(200) });
    expect(title.endsWith('…')).toBe(true);
    expect(title.includes('...')).toBe(false);
  });

  test("titles AiderDesk's own tool names", () => {
    expect(formatToolTitle('read_file', { file_path: '/a/b.ts' })).toBe('Read: /a/b.ts');
    expect(formatToolTitle('edit_block', { file_path: '/a/b.ts', old_string: 'x' })).toBe('Edit: /a/b.ts');
    expect(formatToolTitle('write_file', { file_path: '/a/b.ts' })).toBe('Write: /a/b.ts');
    expect(formatToolTitle('search_files', { path: '/a', query: 'tool call params' })).toBe(
      'Search: tool call params',
    );
    expect(formatToolTitle('execute_command', { command: 'rtk git status' })).toBe('Bash: rtk git status');
  });

  test('derives a title from the arguments of tools it has no case for', () => {
    expect(formatToolTitle('desktop.read_file', { path: '/a/b.ts' })).toBe('Desktop.read_file: /a/b.ts');
    expect(formatToolTitle('code_mode', { code: 'local r = 1\nprint(r)' })).toBe('Code_mode: local r = 1 print(r)');
    expect(formatToolTitle('update_item_completion', { name: 'step one', completed: true })).toBe(
      'Update_item_completion: step one',
    );
  });

  test('falls back to the tool name when no argument says anything', () => {
    expect(formatToolTitle('todo.set_items', { items: [] })).toBe('Todo.set_items');
    expect(formatToolTitle('todo.get_items', {})).toBe('Todo.get_items');
  });

  test('keeps a derived title on one shortened line', () => {
    const title = formatToolTitle('code_mode', { code: `local x = "${'y'.repeat(200)}"\nreturn x` });
    expect(title.startsWith('Code_mode: local x = "')).toBe(true);
    expect(title.includes('\n')).toBe(false);
    expect(title.endsWith('…')).toBe(true);
  });

  test('collapses the whitespace a multi-line command carries', () => {
    expect(formatToolTitle('bash', { command: 'cd /tmp &&\n  make   test' })).toBe('Bash: cd /tmp && make test');
  });
});

describe('parseToolResponse & isToolFailed', () => {
  test('parses JSON responses', () => {
    expect(parseToolResponse('{"ok":true}')).toEqual({ ok: true });
    expect(parseToolResponse('plain text')).toBe('plain text');
    expect(parseToolResponse('')).toBeUndefined();
  });

  test('trusts an MCP result isError flag', () => {
    expect(isToolFailed('bash', { content: [{ type: 'text', text: 'boom' }], isError: true })).toBe(true);
    expect(isToolFailed('bash', { content: [], isError: false })).toBe(false);
  });

  test('detects a failure a text response leads with', () => {
    expect(isToolFailed('bash', 'Error: permission denied')).toBe(true);
    expect(isToolFailed('bash', 'Failed to run the command')).toBe(true);
    expect(isToolFailed('bash', 'Action cancelled')).toBe(true);
    expect(isToolFailed('bash', 'all good')).toBe(false);
  });

  test('does not call a call failed because its output mentions failure', () => {
    // A file or a log line that merely contains the word used to fail the call.
    expect(isToolFailed('bash', 'src/errors.ts: the build failed handler')).toBe(false);
    expect(isToolFailed('bash', { ok: true })).toBe(false);
  });
});

describe('stripAnsi', () => {
  test('drops colour sequences', () => {
    expect(stripAnsi('\u001b[31mred\u001b[0m text')).toBe('red text');
  });
});

describe('asCallToolResult', () => {
  test('recognises an MCP result', () => {
    expect(asCallToolResult({ content: [{ type: 'text', text: 'hi' }] })).toEqual({
      content: [{ type: 'text', text: 'hi' }],
    });
  });

  test('rejects anything else', () => {
    expect(asCallToolResult('text')).toBeUndefined();
    expect(asCallToolResult([{ type: 'text', text: 'hi' }])).toBeUndefined();
    expect(asCallToolResult({ a: 1 })).toBeUndefined();
    expect(asCallToolResult({ content: 'nope' })).toBeUndefined();
    expect(asCallToolResult(null)).toBeUndefined();
  });
});

describe('toolResultText', () => {
  test('unwraps an MCP result to its text', () => {
    expect(toolResultText({ content: [{ type: 'text', text: 'hello' }], isError: false })).toBe('hello');
    expect(
      toolResultText({
        content: [
          { type: 'text', text: 'one' },
          { type: 'text', text: 'two' },
        ],
      }),
    ).toBe('one\n\ntwo');
  });

  test('passes plain text and empty responses through', () => {
    expect(toolResultText('plain')).toBe('plain');
    expect(toolResultText(undefined)).toBe('');
    expect(toolResultText('')).toBe('');
  });

  test('pretty-prints a payload that is not an MCP result', () => {
    expect(toolResultText({ a: 1 })).toBe(JSON.stringify({ a: 1 }, null, 2));
  });
});

describe('buildToolCallContentArray', () => {
  test('file_edit produces a diff block and the response text', () => {
    const content = buildToolCallContentArray(
      'file_edit',
      { filePath: '/a', searchTerm: 'old', replacementText: 'new' },
      'Successfully edited',
    );
    expect(content).toEqual([
      { type: 'diff', path: '/a', oldText: 'old', newText: 'new' },
      { type: 'content', content: { type: 'text', text: 'Successfully edited' } },
    ]);
  });

  test('file_write produces a diff with null oldText', () => {
    const content = buildToolCallContentArray('file_write', { filePath: '/a', content: 'hello' }, undefined);
    expect(content).toEqual([{ type: 'diff', path: '/a', oldText: null, newText: 'hello' }]);
  });

  test('file_read returns text content', () => {
    const content = buildToolCallContentArray('file_read', { filePath: '/a' }, 'file body');
    expect(content).toEqual([{ type: 'content', content: { type: 'text', text: 'file body' } }]);
  });

  test('glob formats arrays with counts', () => {
    const content = buildToolCallContentArray('glob', { pattern: '**/*.ts' }, ['a.ts', 'b.ts']);
    expect(content[0].type).toBe('content');
    const text = (content[0] as { content: { text: string } }).content.text;
    expect(text).toContain('Found 2 files');
    expect(text).toContain('a.ts');
  });

  test('glob says so when nothing matched', () => {
    const content = buildToolCallContentArray('glob', { pattern: '**/*.zzz' }, []);
    const text = (content[0] as { content: { text: string } }).content.text;
    expect(text).toBe('No files found.');
  });

  test('grep empty response says no matches', () => {
    const content = buildToolCallContentArray('grep', { searchTerm: 'x' }, '');
    const text = (content[0] as { content: { text: string } }).content.text;
    expect(text).toBe('No matches found.');
  });

  test('semantic_search falls back to no results', () => {
    const content = buildToolCallContentArray('semantic_search', { query: 'x' }, undefined);
    const text = (content[0] as { content: { text: string } }).content.text;
    expect(text).toBe('No results found.');
  });

  test('object responses are JSON-stringified once', () => {
    const content = buildToolCallContentArray('tool', {}, { a: 1 });
    const text = (content[0] as { content: { text: string } }).content.text;
    expect(text).toBe(JSON.stringify({ a: 1 }, null, 2));
  });

  test('an MCP text result is unwrapped, not re-encoded', () => {
    const content = buildToolCallContentArray(
      'desktop.read_file',
      {},
      { content: [{ type: 'text', text: 'file body' }], isError: false },
    );
    expect(content).toEqual([{ type: 'content', content: { type: 'text', text: 'file body' } }]);
  });

  test('an MCP image result keeps its image block', () => {
    const content = buildToolCallContentArray(
      'desktop.read_file',
      {},
      { content: [{ type: 'image', data: 'base64img', mimeType: 'image/png' }] },
    );
    expect(content).toEqual([
      { type: 'content', content: { type: 'image', data: 'base64img', mimeType: 'image/png' } },
    ]);
  });

  test('an empty MCP result reports no content', () => {
    expect(buildToolCallContentArray('tool', {}, { content: [], isError: false })).toEqual([]);
  });

  test('bash sends its output as text, not a dangling terminal', () => {
    const content = buildToolCallContentArray('bash', { command: 'ls', _terminalId: 't1' }, 'output');
    expect(content).toEqual([{ type: 'content', content: { type: 'text', text: 'output' } }]);
  });

  test('strips the colour codes a terminal would have rendered', () => {
    const content = buildToolCallContentArray('bash', { command: 'ls' }, '\u001b[32mok\u001b[0m');
    const text = (content[0] as { content: { text: string } }).content.text;
    expect(text).toBe('ok');
  });
});

describe('contentBlocksToPrompt', () => {
  test('joins text, resource and resource_link blocks', () => {
    const { prompt } = contentBlocksToPrompt([
      { type: 'text', text: 'hello' },
      { type: 'resource', resource: { text: 'world' } },
      { type: 'resource_link', uri: 'file:///a', name: 'a' },
    ] as never);
    expect(prompt).toBe('hello\n\nworld\n\n@a');
  });

  test('collects image data', () => {
    const { images } = contentBlocksToPrompt([
      { type: 'text', text: 'look' },
      { type: 'image', data: 'base64img' },
    ] as never);
    expect(images).toEqual(['base64img']);
  });
});