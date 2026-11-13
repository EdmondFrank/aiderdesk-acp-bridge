/** A compaction must free at least this share of the context to count as one. */
export const COMPACTION_SHRINK_RATIO = 0.98;

/** Total display size of a task context; `undefined` when the context can't be read. */
export const contextCharsOf = (messages: { content?: string }[] | undefined): number | undefined => {
  if (!messages) {
    return undefined;
  }
  return messages.reduce((total, message) => total + (message.content?.length ?? 0), 0);
};

export const formatChars = (chars: number | undefined): string =>
  chars === undefined ? 'an unknown size' : `${Math.round(chars / 1024)} KB`;

export type CompactionOutcome = {
  /** Whether the context is now meaningfully smaller than before. */
  shrank: boolean;
  /** Human-readable size transition, for logs and notes. */
  detail: string;
};

/**
 * A compaction is only reported as a success when the context actually shrank.
 *
 * AiderDesk's smart compaction only rewrites its own `power` tool results, so a
 * session that lives on MCP tools answers 200 and changes nothing — and the
 * message it leaves at the end of the context is then the previous assistant
 * reply, not a summary. Relaying that as "the conversation was replaced by this
 * summary" tells the agent something false about its own history.
 */
export const evaluateCompaction = (beforeChars?: number, afterChars?: number): CompactionOutcome => {
  if (beforeChars === undefined || afterChars === undefined) {
    // Can't measure: keep the historical best-effort behaviour.
    return { shrank: true, detail: 'context size unavailable' };
  }
  return {
    shrank: afterChars < beforeChars * COMPACTION_SHRINK_RATIO,
    detail: `${formatChars(beforeChars)} -> ${formatChars(afterChars)}`,
  };
};