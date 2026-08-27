import { describe, expect, test } from 'bun:test';

import {
  buildToolCallContentArray,
  contentBlocksToPrompt,
  extractFilePath,
  formatToolInputAsText,
  formatToolTitle,
  inferToolKind,
  isToolFailed,
  parseToolArgs,
  parseToolResponse,
} from '../src/tools';

describe('inferToolKind', () => {
  test('infers kinds from tool names', () => {
    expect(inferToolKind('file_read')).toBe('read');
    expect(inferToolKind('file_edit')).toBe('edit');
    expect(inferToolKind('file_write')).toBe('edit');
    expect(inferToolKind('file_delete')).toBe('delete');
    expect(inferToolKind('file_move')).toBe('move');
    expect(inferToolKind('grep')).toBe('search');
    expect(inferToolKind('glob')).toBe('search');
    expect(inferToolKind('bash')).toBe('execute');
    expect(inferToolKind('think')).toBe('think');
    expect(inferToolKind('fetch')).toBe('fetch');
    expect(inferToolKind('weird_tool')).toBe('other');
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
  test('prefers filePath then path', () => {
    expect(extractFilePath('file_read', { filePath: '/a', path: '/b' })).toBe('/a');
    expect(extractFilePath('file_read', { path: '/b' })).toBe('/b');
    expect(extractFilePath('bash', { command: 'ls' })).toBeUndefined();
  });
});

describe('formatToolInputAsText', () => {
  test('formats known keys nicely', () => {
    const text = formatToolInputAsText('grep', { searchTerm: 'foo', filePattern: '*.ts' });
    expect(text).toContain('Search: foo');
    expect(text).toContain('Files: *.ts');
  });

  test('appends unknown keys', () => {
    const text = formatToolInputAsText('tool', { mystery: 'value' });
    expect(text).toContain('mystery: value');
  });

  test('truncates long unknown values', () => {
    const text = formatToolInputAsText('tool', { mystery: 'x'.repeat(300) });
    expect(text).toContain('...');
  });

  test('skips known keys', () => {
    const text = formatToolInputAsText('file_edit', { replacementText: 'b', content: 'c', mode: 'edit', id: 'x' });
    expect(text).toBe('');
  });
});

describe('formatToolTitle', () => {
  test('formats specific tools', () => {
    expect(formatToolTitle('grep', { searchTerm: 'foo', filePattern: '*.ts' })).toBe('Grep: "foo" in *.ts');
    expect(formatToolTitle('bash', { command: 'ls -la' })).toBe('Bash: ls -la');
    expect(formatToolTitle('file_read', { filePath: '/a' })).toBe('Read: /a');
    expect(formatToolTitle('unknown_tool', {})).toBe('Unknown_tool');
  });

  test('truncates long inputs', () => {
    const title = formatToolTitle('bash', { command: 'x'.repeat(200) });
    expect(title.endsWith('...')).toBe(true);
  });
});

describe('parseToolResponse & isToolFailed', () => {
  test('parses JSON responses', () => {
    expect(parseToolResponse('{"ok":true}')).toEqual({ ok: true });
    expect(parseToolResponse('plain text')).toBe('plain text');
    expect(parseToolResponse('')).toBeUndefined();
  });

  test('detects failure from string responses', () => {
    expect(isToolFailed('bash', 'Error: permission denied')).toBe(true);
    expect(isToolFailed('bash', 'build failed')).toBe(true);
    expect(isToolFailed('bash', 'Action cancelled')).toBe(true);
    expect(isToolFailed('bash', { ok: true })).toBe(false);
    expect(isToolFailed('bash', 'all good')).toBe(false);
  });
});

describe('buildToolCallContentArray', () => {
  test('file_edit produces a diff block', () => {
    const content = buildToolCallContentArray('file_edit', { filePath: '/a', searchTerm: 'old', replacementText: 'new' }, 'Successfully edited');
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

  test('object responses are JSON-stringified', () => {
    const content = buildToolCallContentArray('tool', {}, { a: 1 });
    const text = (content[0] as { content: { text: string } }).content.text;
    expect(text).toBe(JSON.stringify({ a: 1 }, null, 2));
  });

  test('bash adds a terminal block', () => {
    const content = buildToolCallContentArray('bash', { command: 'ls', _terminalId: 't1' }, 'output');
    expect(content[0]).toEqual({ type: 'terminal', terminalId: 't1' });
    expect(content[1]).toEqual({ type: 'content', content: { type: 'text', text: 'output' } });
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