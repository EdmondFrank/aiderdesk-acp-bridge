import type { Extension, ExtensionContext, OptimizeMessagesEvent } from '@aiderdesk/extensions';

import {
    elideToolResults,
    elisionOptionsFromEnv,
    raftPolicyEnabled,
    type PolicyMessage,
} from './policy';

/**
 * Keeps a long-lived Raft agent's context from growing without bound.
 *
 * Raft never recycles an AiderDesk-backed agent (its wake-recycle logic only
 * reads transcripts for the `claude` runtime), so a single task accumulates
 * every tool result the agent ever produced. AiderDesk compacts at a token
 * threshold long before that, but compaction is expensive and loses detail;
 * eliding results the agent has already finished with delays it in the first
 * place and keeps cache reads cheaper in between.
 */
export default class RaftPolicyExtension implements Extension {
    static metadata = {
        name: 'Raft Policy',
        version: '0.1.0',
        description: 'Elides stale tool results for long-lived Raft agents',
        author: 'aiderdesk-acp-bridge',
        capabilities: [],
    };

    async onOptimizeMessages(
        event: OptimizeMessagesEvent,
        context: ExtensionContext,
    ): Promise<void | Partial<OptimizeMessagesEvent>> {
        if (!raftPolicyEnabled(context.getProjectDir(), process.env)) {
            return;
        }

        const result = elideToolResults(event.optimizedMessages as unknown as PolicyMessage[], elisionOptionsFromEnv(process.env));
        if (result.stats.elided === 0) {
            return;
        }

        context.log(
            `elided ${result.stats.elided} stale tool result(s), ~${Math.round(result.stats.savedChars / 1024)} KB freed`,
            'debug',
        );

        return { optimizedMessages: result.messages as unknown as OptimizeMessagesEvent['optimizedMessages'] };
    }
}
