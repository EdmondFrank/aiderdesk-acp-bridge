/**
 * Tool-result elision for long-lived Raft agents.
 *
 * A Raft agent keeps one AiderDesk task for its whole lifetime, so the context
 * only ever grows: `context.json` reached ~1 MB after a couple of days, with
 * tool results the single largest contributor. AiderDesk truncates a result
 * when it is produced, but never afterwards, so old results keep costing tokens
 * (and cache reads) long after they stopped being useful.
 *
 * This module keeps the most recent results intact and shrinks everything older
 * to a head plus a note that the output can be re-read by re-running the tool.
 */

export type PolicyMessage = {
    role?: unknown;
    content?: unknown;
    [key: string]: unknown;
};

export type ElisionOptions = {
    /** Most recent tool results left untouched. */
    keepRecent: number;
    /** Results longer than this are cut to `maxChars`. */
    maxChars: number;
    /** Older results beyond this many retained characters are cut harder. */
    budgetChars: number;
};

export type ElisionStats = {
    elided: number;
    savedChars: number;
};

export const DEFAULT_ELISION_OPTIONS: ElisionOptions = {
    keepRecent: 8,
    maxChars: 4000,
    budgetChars: 120_000,
};

/** A cut smaller than this is not worth losing the output for. */
const MIN_GAIN_CHARS = 500;

/** Head kept when an old result also exceeds the retained-character budget. */
const HARD_CUT_CHARS = 400;

function elisionNote(omitted: number): string {
    return `\n\n[… ${omitted} characters elided by raft-policy: this output has left the recent context. Re-run the tool if you need it again.]`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}

/** The `output` of a `tool-result` part, if the part has one. */
function toolResultOutput(part: unknown): Record<string, unknown> | undefined {
    const record = asRecord(part);
    if (!record || record.type !== 'tool-result') {
        return undefined;
    }
    return asRecord(record.output);
}

/**
 * Text of a tool result we are willing to rewrite.
 *
 * AiderDesk stores the AI SDK `content` shape — `{ type: 'content', value: [
 * { type: 'text', text }, { type: 'file', … } ] }` — for anything a tool returns
 * as rich output, and `{ type: 'text' | 'error-text', value }` for plain text.
 * Both are handled; `json` and `execution-denied` outputs are never touched.
 */
function textOfToolResult(part: unknown): string | undefined {
    const output = toolResultOutput(part);
    if (!output) {
        return undefined;
    }
    if (output.type === 'text' || output.type === 'error-text') {
        return typeof output.value === 'string' ? output.value : undefined;
    }
    if (output.type === 'content' && Array.isArray(output.value)) {
        const texts: string[] = [];
        for (const item of output.value) {
            const record = asRecord(item);
            if (record?.type === 'text' && typeof record.text === 'string') {
                texts.push(record.text);
            }
        }
        return texts.length > 0 ? texts.join('\n') : undefined;
    }
    return undefined;
}

/**
 * Copy of `part` with its text cut to `headChars` characters plus a note.
 *
 * For the `content` shape only the `text` parts are cut: a `file` (image)
 * part is kept untouched, because dropping it changes what the model sees
 * rather than how much of it it reads.
 */
function elidePart(
    part: unknown,
    headChars: number,
    original: string,
): { part: unknown; textLength: number } | undefined {
    const output = toolResultOutput(part);
    const record = asRecord(part);
    if (!output || !record) {
        return undefined;
    }

    if (output.type === 'text' || output.type === 'error-text') {
        if (typeof output.value !== 'string') {
            return undefined;
        }
        const kept = output.value.slice(0, headChars);
        const note = elisionNote(output.value.length - kept.length);
        const value = `${kept}${note}`;
        return { part: { ...record, output: { ...output, value } }, textLength: value.length };
    }

    if (output.type !== 'content' || !Array.isArray(output.value)) {
        return undefined;
    }

    let remaining = headChars;
    let lastText: Record<string, unknown> | undefined;
    const value: unknown[] = [];
    for (const item of output.value) {
        const itemRecord = asRecord(item);
        if (itemRecord?.type === 'text' && typeof itemRecord.text === 'string') {
            if (remaining <= 0) {
                // Fully elided: the note says the output can be re-read.
                continue;
            }
            const kept = itemRecord.text.slice(0, remaining);
            remaining -= kept.length;
            const next = { ...itemRecord, text: kept };
            value.push(next);
            lastText = next;
            continue;
        }
        value.push(item);
    }

    if (!lastText) {
        return undefined;
    }

    const keptChars = headChars - Math.max(remaining, 0);
    const note = elisionNote(Math.max(original.length - keptChars, 0));
    lastText.text = `${String(lastText.text)}${note}`;

    return {
        part: { ...record, output: { ...output, value } },
        textLength: keptChars + note.length,
    };
}

type Candidate = {
    messageIndex: number;
    partIndex: number;
    length: number;
};

/**
 * Copy-on-write elision: unchanged messages are returned as-is, so the model
 * provider's prompt cache stays valid for everything before the first rewrite.
 */
export function elideToolResults<M extends PolicyMessage>(
    messages: M[],
    options: ElisionOptions = DEFAULT_ELISION_OPTIONS,
): { messages: M[]; stats: ElisionStats } {
    const stats: ElisionStats = { elided: 0, savedChars: 0 };
    const candidates: Candidate[] = [];

    messages.forEach((message, messageIndex) => {
        if (!message || message.role !== 'tool' || !Array.isArray(message.content)) {
            return;
        }
        message.content.forEach((part, partIndex) => {
            const text = textOfToolResult(part);
            if (text !== undefined) {
                candidates.push({ messageIndex, partIndex, length: text.length });
            }
        });
    });

    if (candidates.length <= options.keepRecent) {
        return { messages, stats };
    }

    const droppable = candidates.slice(0, candidates.length - options.keepRecent);
    const replacements = new Map<string, unknown>();
    let retained = 0;

    for (let index = droppable.length - 1; index >= 0; index--) {
        const candidate = droppable[index];
        const overBudget = retained > options.budgetChars;
        if (!overBudget && candidate.length <= options.maxChars) {
            retained += candidate.length;
            continue;
        }

        const part = (messages[candidate.messageIndex].content as unknown[])[candidate.partIndex];
        const original = textOfToolResult(part);
        if (original === undefined) {
            continue;
        }

        const headChars = overBudget ? Math.min(options.maxChars, HARD_CUT_CHARS) : options.maxChars;
        const elided = elidePart(part, headChars, original);
        if (!elided) {
            retained += candidate.length;
            continue;
        }

        const saved = original.length - elided.textLength;
        if (saved < MIN_GAIN_CHARS) {
            retained += candidate.length;
            continue;
        }

        replacements.set(`${candidate.messageIndex}:${candidate.partIndex}`, elided.part);
        stats.elided += 1;
        stats.savedChars += saved;
        retained += elided.textLength;
    }

    if (replacements.size === 0) {
        return { messages, stats };
    }

    const rewritten = messages.map((message, messageIndex) => {
        if (!message || message.role !== 'tool' || !Array.isArray(message.content)) {
            return message;
        }
        let changed = false;
        const content = (message.content as unknown[]).map((part, partIndex) => {
            const replacement = replacements.get(`${messageIndex}:${partIndex}`);
            if (replacement === undefined) {
                return part;
            }
            changed = true;
            return replacement;
        });
        return changed ? ({ ...message, content } as M) : message;
    });

    return { messages: rewritten, stats };
}

/** How far a tool result was cut: `soft` keeps the head, `hard` the minimum. */
export type ElisionDecision = 'soft' | 'hard';

/**
 * Decisions already taken, keyed by `toolCallId`.
 *
 * A result that has a decision is never re-decided. That is the whole point:
 * the provider caches a request prefix, so re-deciding an old result (as the
 * single-pass version does when the retained-character budget shifts) rewrites
 * text near the start of the conversation and makes everything after it be
 * billed again at full price.
 */
export type ElisionMemo = Map<string, ElisionDecision>;

type MemoCandidate = {
    messageIndex: number;
    partIndex: number;
    key: string;
    length: number;
};

/** Identity of a tool result that survives across turns. */
function candidateKey(part: unknown, messageIndex: number, partIndex: number): string {
    const toolCallId = asRecord(part)?.toolCallId;
    return typeof toolCallId === 'string' && toolCallId ? toolCallId : `${messageIndex}:${partIndex}`;
}

/** Head length a decision leaves behind. */
function headCharsFor(decision: ElisionDecision, options: ElisionOptions): number {
    return decision === 'hard' ? Math.min(options.maxChars, HARD_CUT_CHARS) : options.maxChars;
}

/** Length of the text a decision leaves behind: the head plus the elision note. */
function cutLengthOf(length: number, decision: ElisionDecision, options: ElisionOptions): number {
    const head = headCharsFor(decision, options);
    return head + elisionNote(Math.max(length - head, 0)).length;
}

function memoCandidates(messages: PolicyMessage[]): MemoCandidate[] {
    const candidates: MemoCandidate[] = [];
    messages.forEach((message, messageIndex) => {
        if (!message || message.role !== 'tool' || !Array.isArray(message.content)) {
            return;
        }
        message.content.forEach((part, partIndex) => {
            if (asRecord(part)?.type !== 'tool-result') {
                return;
            }
            const text = textOfToolResult(part);
            if (text !== undefined) {
                candidates.push({ messageIndex, partIndex, key: candidateKey(part, messageIndex, partIndex), length: text.length });
            }
        });
    });
    return candidates;
}

/**
 * Decide which stale results to cut, recording each decision in `memo`.
 *
 * Intended to run when a fresh wake starts — a moment the provider cache has
 * either expired or is about to — rather than on every dispatch. Results that
 * already carry a decision are only accounted for, never re-decided, so the
 * emitted prefix stays identical for the rest of the wake.
 *
 * @returns the number of results decided by this pass.
 */
export function decideElisions(
    messages: PolicyMessage[],
    options: ElisionOptions,
    memo: ElisionMemo,
): number {
    const candidates = memoCandidates(messages);
    if (candidates.length <= options.keepRecent) {
        return 0;
    }

    const droppable = candidates.slice(0, candidates.length - options.keepRecent);
    let retained = 0;
    let decided = 0;

    for (let index = droppable.length - 1; index >= 0; index--) {
        const candidate = droppable[index];
        const existing = memo.get(candidate.key);
        if (existing) {
            retained += cutLengthOf(candidate.length, existing, options);
            continue;
        }

        const overBudget = retained > options.budgetChars;
        if (!overBudget && candidate.length <= options.maxChars) {
            retained += candidate.length;
            continue;
        }

        const decision: ElisionDecision = overBudget ? 'hard' : 'soft';
        const cut = cutLengthOf(candidate.length, decision, options);
        if (candidate.length - cut < MIN_GAIN_CHARS) {
            retained += candidate.length;
            continue;
        }

        memo.set(candidate.key, decision);
        retained += cut;
        decided += 1;
    }

    return decided;
}

/**
 * Emit the cuts `memo` already decided. Messages without a decision are
 * returned as-is (by identity), so an unchanged conversation keeps its cache.
 */
export function applyElisions(
    messages: PolicyMessage[],
    memo: ElisionMemo,
    options: ElisionOptions = DEFAULT_ELISION_OPTIONS,
): { messages: PolicyMessage[]; stats: ElisionStats } {
    const stats: ElisionStats = { elided: 0, savedChars: 0 };
    if (memo.size === 0) {
        return { messages, stats };
    }

    const replacements = new Map<string, unknown>();

    messages.forEach((message, messageIndex) => {
        if (!message || message.role !== 'tool' || !Array.isArray(message.content)) {
            return;
        }
        message.content.forEach((part, partIndex) => {
            const decision = memo.get(candidateKey(part, messageIndex, partIndex));
            if (!decision) {
                return;
            }
            const original = textOfToolResult(part);
            if (original === undefined) {
                return;
            }
            const elided = elidePart(part, headCharsFor(decision, options), original);
            if (!elided) {
                return;
            }
            const saved = original.length - elided.textLength;
            // Nothing left to save: the stored text is already this short.
            if (saved <= 0) {
                return;
            }
            replacements.set(`${messageIndex}:${partIndex}`, elided.part);
            stats.elided += 1;
            stats.savedChars += saved;
        });
    });

    if (replacements.size === 0) {
        return { messages, stats };
    }

    const rewritten = messages.map((message, messageIndex) => {
        if (!message || message.role !== 'tool' || !Array.isArray(message.content)) {
            return message;
        }
        let changed = false;
        const content = (message.content as unknown[]).map((part, partIndex) => {
            const replacement = replacements.get(`${messageIndex}:${partIndex}`);
            if (replacement === undefined) {
                return part;
            }
            changed = true;
            return replacement;
        });
        return changed ? { ...message, content } : message;
    });

    return { messages: rewritten, stats };
}

/** Characters the tool results in `messages` would occupy under `memo`. */
export function effectiveToolResultChars(
    messages: PolicyMessage[],
    memo: ElisionMemo,
    options: ElisionOptions = DEFAULT_ELISION_OPTIONS,
): number {
    let total = 0;
    for (const candidate of memoCandidates(messages)) {
        const decision = memo.get(candidate.key);
        total += decision ? cutLengthOf(candidate.length, decision, options) : candidate.length;
    }
    return total;
}

/**
 * What the tool results in a request cost under `memo`, split by whether a pass
 * has looked at them yet.
 *
 * `pendingChars` is the growth signal: stale results that no pass has decided
 * about are what make the context creep up, and they are what a pass shrinks.
 */
export type ElisionBudget = {
    /** Tool results in the request. */
    candidates: number;
    /** Characters those results occupy under `memo`. */
    totalChars: number;
    /** Characters of stale results (beyond `keepRecent`) with no decision. */
    pendingChars: number;
};

export function elisionBudget(
    messages: PolicyMessage[],
    memo: ElisionMemo,
    options: ElisionOptions = DEFAULT_ELISION_OPTIONS,
): ElisionBudget {
    const candidates = memoCandidates(messages);
    const droppable = Math.max(candidates.length - options.keepRecent, 0);
    let totalChars = 0;
    let pendingChars = 0;

    candidates.forEach((candidate, index) => {
        const decision = memo.get(candidate.key);
        totalChars += decision ? cutLengthOf(candidate.length, decision, options) : candidate.length;
        // Only results a pass would actually cut count as growth; one that is
        // already shorter than `maxChars` is never worth cutting, and counting
        // it would make the growth trigger fire forever.
        if (index < droppable && !decision && candidate.length > options.maxChars) {
            pendingChars += candidate.length;
        }
    });

    return { candidates: candidates.length, totalChars, pendingChars };
}

/** When a dispatch counts as a fresh wake, and how large results may grow. */
export type PolicyRuntime = {
    /** A gap at least this long starts a new wake, where deciding cuts is free. */
    epochIdleMs: number;
    /** Tool results above this size force a decision pass even mid-wake. */
    ceilingChars: number;
    /** Stale, undecided characters worth a mid-wake pass (one cache break). */
    pendingChars: number;
};

export function policyRuntimeFromEnv(env: Record<string, string | undefined>): PolicyRuntime {
    return {
        epochIdleMs: readInt(env, 'AIDERDESK_RAFT_ELIDE_AFTER_IDLE_MS', 30 * 60_000, 0, 24 * 60 * 60_000),
        ceilingChars: readInt(env, 'AIDERDESK_RAFT_TOOL_RESULT_CEILING_CHARS', 400_000, 0, 100_000_000),
        pendingChars: readInt(env, 'AIDERDESK_RAFT_ELIDE_PENDING_CHARS', 160_000, 0, 100_000_000),
    };
}

function readInt(
    env: Record<string, string | undefined>,
    name: string,
    fallback: number,
    min: number,
    max: number,
): number {
    const raw = env[name];
    if (raw === undefined) {
        return fallback;
    }
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) {
        return fallback;
    }
    return Math.min(Math.max(parsed, min), max);
}

/** Elision knobs, read once per turn from the environment. */
export function elisionOptionsFromEnv(env: Record<string, string | undefined>): ElisionOptions {
    return {
        keepRecent: readInt(env, 'AIDERDESK_RAFT_KEEP_TOOL_RESULTS', DEFAULT_ELISION_OPTIONS.keepRecent, 0, 200),
        maxChars: readInt(env, 'AIDERDESK_RAFT_TOOL_RESULT_MAX_CHARS', DEFAULT_ELISION_OPTIONS.maxChars, 200, 1_000_000),
        budgetChars: readInt(env, 'AIDERDESK_RAFT_TOOL_RESULT_BUDGET_CHARS', DEFAULT_ELISION_OPTIONS.budgetChars, 0, 100_000_000),
    };
}

/**
 * Whether the policy applies to a project. Raft agents live under
 * `~/.raft/agents/<id>`; anything else is an ordinary AiderDesk project that
 * keeps its full history, so it is left alone unless explicitly enabled.
 */
export function raftPolicyEnabled(projectDir: string, env: Record<string, string | undefined>): boolean {
    const flag = (env.AIDERDESK_RAFT_POLICY ?? '').trim().toLowerCase();
    if (flag === '0' || flag === 'false' || flag === 'off' || flag === 'no') {
        return false;
    }
    if (flag === '1' || flag === 'true' || flag === 'on' || flag === 'yes') {
        return true;
    }
    return /[/\\]\.raft[/\\]agents[/\\]/.test(projectDir);
}