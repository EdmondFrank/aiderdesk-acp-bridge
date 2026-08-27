export type SSEEvent = {
  type: string;
  data: string;
};

const decoder = new TextDecoder();

/**
 * Parse a server-sent-events stream from a web ReadableStream.
 * Handles multi-line data blocks, `event:` fields, and comment lines.
 * Events split across chunk boundaries and a final event without a
 * trailing blank line are both supported.
 */
export async function* parseSSEEvents(stream: ReadableStream<Uint8Array>): AsyncGenerator<SSEEvent> {
  let buffer = '';
  let currentEventType = '';
  let currentDataLines: string[] = [];

  const flushEvent = (): SSEEvent | undefined => {
    if (currentDataLines.length === 0) {
      return undefined;
    }
    const event: SSEEvent = {
      type: currentEventType || 'message',
      data: currentDataLines.join('\n'),
    };
    currentEventType = '';
    currentDataLines = [];
    return event;
  };

  const handleLine = (rawLine: string): SSEEvent | undefined => {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line.startsWith(':')) {
      // comment / keep-alive
      return undefined;
    }
    if (line.trim() === '') {
      return flushEvent();
    }
    if (line.startsWith('event:')) {
      currentEventType = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      currentDataLines.push(line.slice(5).trimStart());
    }
    return undefined;
  };

  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const event = handleLine(line);
        if (event) {
          yield event;
        }
      }
    }
    // At end of stream the buffer may hold a final complete line that was
    // never terminated with a blank line.
    if (buffer.length > 0) {
      const event = handleLine(buffer);
      if (event) {
        yield event;
      }
    }
    const finalEvent = flushEvent();
    if (finalEvent) {
      yield finalEvent;
    }
  } finally {
    reader.releaseLock();
  }
}