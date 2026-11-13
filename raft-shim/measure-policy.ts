import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import {
  applyElisions,
  decideElisions,
  elisionBudget,
  elisionOptionsFromEnv,
  effectiveToolResultChars,
  type ElisionMemo,
  type PolicyMessage,
} from './raft-policy/policy';

const contextPath = process.argv[2];
const raw = JSON.parse(readFileSync(contextPath, 'utf8'));
const messages = (raw.contextMessages ?? []) as PolicyMessage[];
const options = elisionOptionsFromEnv({});
const memo: ElisionMemo = new Map();

const sizes: number[] = [];
for (const message of messages) {
  if (!message || message.role !== 'tool' || !Array.isArray(message.content)) {
    continue;
  }
  for (const part of message.content as Record<string, unknown>[]) {
    if ((part as { type?: string }).type !== 'tool-result') {
      continue;
    }
    const output = (part as { output?: { type?: string; value?: unknown } }).output;
    let text: string | undefined;
    if (output?.type === 'text' || output?.type === 'error-text') {
      text = typeof output.value === 'string' ? output.value : undefined;
    } else if (output?.type === 'content' && Array.isArray(output.value)) {
      text = (output.value as Record<string, unknown>[])
        .filter((item) => item.type === 'text')
        .map((item) => String(item.text ?? ''))
        .join('\n');
    }
    if (text !== undefined) {
      sizes.push(text.length);
    }
  }
}

sizes.sort((a, b) => a - b);
const total = sizes.reduce((sum, n) => sum + n, 0);
const over = (limit: number) => sizes.filter((n) => n > limit).length;

console.log(`tool results: ${sizes.length}, total ${(total / 1024).toFixed(0)} KB`);
console.log(`median ${sizes[Math.floor(sizes.length / 2)]}, p90 ${sizes[Math.floor(sizes.length * 0.9)]}, max ${sizes[sizes.length - 1]}`);
console.log(`>4000 chars: ${over(4000)} (${(sizes.filter((n) => n > 4000).reduce((s, n) => s + n, 0) / 1024).toFixed(0)} KB)`);
console.log(`>20000 chars: ${over(20000)}`);

const beforeBudget = elisionBudget(messages, memo, options);
const before = effectiveToolResultChars(messages, memo, options);
const decided = decideElisions(messages, options, memo);
const after = effectiveToolResultChars(messages, memo, options);
const applied = applyElisions(messages, memo, options);

console.log(
  `\nwake-start pass: decided ${decided}, applied ${applied.stats.elided}, ` +
    `tool-result chars ${Math.round(before / 1024)} KB -> ${Math.round(after / 1024)} KB`,
);
console.log(`saved ~${Math.round(applied.stats.savedChars / 1024)} KB of tool-result text`);
const afterBudget = elisionBudget(messages, memo, options);
console.log(
  `budget: ${beforeBudget.candidates} results, pending ${Math.round(beforeBudget.pendingChars / 1024)} KB -> ${Math.round(afterBudget.pendingChars / 1024)} KB`,
);

const second = decideElisions(messages, options, memo);
const reapplied = applyElisions(messages, memo, options);
console.log(`replay: decided ${second} more, re-elided ${reapplied.stats.elided} -> ${Math.round(reapplied.stats.savedChars / 1024)} KB`);
console.log(`memo entries ${memo.size}`);