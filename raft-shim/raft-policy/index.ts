import type { Extension, ExtensionContext, OptimizeMessagesEvent } from '@aiderdesk/extensions';

import * as policyModule from './policy';
import type { ElisionMemo, PolicyMessage } from './policy';

type ProjectState = {
    /** Cuts already decided for this project, never re-decided. */
    memo: ElisionMemo;
    /** When the previous dispatch happened; a long gap starts a new wake. */
    lastDispatchAt: number;
};

/** Why a pass ran; only the first reason in priority order is reported. */
type PassReason = 'first' | 'wake' | 'ceiling' | 'growth';

const kb = (chars: number): string => `${Math.round(chars / 1024)} KB`;

/**
 * Copies the cut text back onto the message objects the host handed us.
 *
 * Returning a fresh `optimizedMessages` array is not enough in practice: the
 * AiderDesk server this bridge targets drops the returned array and only reads
 * the objects it already holds. Measured A/B on a live session — writing the
 * same cuts back in place took the billed prompt from 133,720 to 95,924 tokens
 * (-28%), while the identical cuts returned as a new array changed nothing.
 * Mutating is safe because the host hands the hook a deep clone of its context,
 * never the stored messages, so this keeps the return path working on builds
 * that honour it and covers the build that does not.
 */
const applyInPlace = (targets: PolicyMessage[], sources: readonly PolicyMessage[]): void => {
    sources.forEach((source, index) => {
        const target = targets[index] as unknown as { content?: unknown };
        const cut = source as unknown as { content?: unknown };
        if (target && cut && JSON.stringify(target.content) !== JSON.stringify(cut.content)) {
            target.content = cut.content;
        }
    });
};

/**
 * Keeps a long-lived Raft agent's context from growing without bound, without
 * paying for it on every turn.
 *
 * AiderDesk hands the model a request prefix that the provider caches, so the
 * cost of a turn is dominated by how much of that prefix is *not* cached. Any
 * edit to an old message invalidates everything after it, which is why the
 * earlier "recompute the best elision on every turn" version measured ~2.6M
 * re-billed tokens over 140 turns (30% of that task's lifetime spend).
 *
 * So cuts are decided once per pass, and replayed verbatim in between: results
 * that have already left the recent window keep exactly the text they were cut
 * to, and new results stay whole until a pass decides about them.
 */
export default class RaftPolicyExtension implements Extension {
    static metadata = {
        name: 'Raft Policy',
        version: '0.4.0',
        description: 'Elides stale tool results for long-lived Raft agents without breaking the prompt cache',
        author: 'aiderdesk-acp-bridge',
        capabilities: [],
    };

    private readonly states = new Map<string, ProjectState>();
    private legacyFallbackLogged = false;

    /**
     * A hot-reloaded extension can be linked against a cached copy of `./policy`
     * from before the wake policy existed. Detect that instead of failing to
     * load, and fall back to the single-pass elision until the next restart.
     */
    private get wakePolicyAvailable(): boolean {
        const candidate = policyModule as Partial<typeof policyModule>;
        return (
            typeof candidate.decideElisions === 'function' &&
            typeof candidate.applyElisions === 'function' &&
            typeof candidate.elisionBudget === 'function'
        );
    }

    /**
     * A hot reload replaces this file but `jiti` keeps the `./policy` module it
     * cached for the directory, so a fresh entry file can be linked against a
     * module from before the wake policy existed. Saying which one loaded turns
     * that silent degradation into a line in the log.
     */
    onLoad(context: ExtensionContext): void {
        context.log(
            this.wakePolicyAvailable
                ? 'loaded: wake policy available'
                : 'loaded: policy module is stale after a hot reload — restart AiderDesk',
            this.wakePolicyAvailable ? 'info' : 'warn',
        );
    }

    private stateFor(projectDir: string): ProjectState {
        let state = this.states.get(projectDir);
        if (!state) {
            state = { memo: new Map(), lastDispatchAt: 0 };
            this.states.set(projectDir, state);
        }
        return state;
    }

    async onOptimizeMessages(
        event: OptimizeMessagesEvent,
        context: ExtensionContext,
    ): Promise<void | Partial<OptimizeMessagesEvent>> {
        const projectDir = context.getProjectDir();
        if (!policyModule.raftPolicyEnabled(projectDir, process.env)) {
            return;
        }

        const messages = event.optimizedMessages as unknown as PolicyMessage[];
        const options = policyModule.elisionOptionsFromEnv(process.env);

        if (!this.wakePolicyAvailable) {
            if (!this.legacyFallbackLogged) {
                this.legacyFallbackLogged = true;
                context.log('policy module is stale after a hot reload; using single-pass elision until restart', 'warn');
            }
            const legacy = policyModule.elideToolResults(messages, options);
            if (legacy.stats.elided === 0) {
                return;
            }
            applyInPlace(messages, legacy.messages);
            return { optimizedMessages: messages as unknown as OptimizeMessagesEvent['optimizedMessages'] };
        }

        const runtime = policyModule.policyRuntimeFromEnv(process.env);
        const state = this.stateFor(projectDir);
        const now = Date.now();
        const idleFor = state.lastDispatchAt === 0 ? Number.POSITIVE_INFINITY : now - state.lastDispatchAt;
        const budget = policyModule.elisionBudget(messages, state.memo, options);

        // `first` matters because the very first dispatch of a process usually
        // arrives after a restart, when the prefix is being rebuilt anyway —
        // waiting for a 30-minute gap there means never cutting at all, which
        // is what a long-lived agent that wakes every few minutes measured.
        const reason: PassReason | undefined =
            state.memo.size === 0 && budget.candidates > options.keepRecent
                ? 'first'
                : idleFor >= runtime.epochIdleMs
                  ? 'wake'
                  : budget.totalChars > runtime.ceilingChars
                    ? 'ceiling'
                    : budget.pendingChars > runtime.pendingChars
                      ? 'growth'
                      : undefined;

        state.lastDispatchAt = now;

        if (reason) {
            const decided = policyModule.decideElisions(messages, options, state.memo);
            const after = policyModule.elisionBudget(messages, state.memo, options);
            const idle =
                idleFor === Number.POSITIVE_INFINITY ? '' : `, idle ${Math.round(idleFor / 60_000)}m`;
            context.log(
                `pass (${reason}${idle}): decided ${decided}, tool results ${kb(budget.totalChars)} -> ${kb(after.totalChars)}, pending ${kb(budget.pendingChars)} -> ${kb(after.pendingChars)}`,
                'info',
            );
        }

        const result = policyModule.applyElisions(messages, state.memo, options);
        if (result.stats.elided === 0) {
            return;
        }

        applyInPlace(messages, result.messages);

        context.log(
            `elided ${result.stats.elided} stale tool result(s), ~${kb(result.stats.savedChars)} freed` +
                (reason ? ' (decided now)' : ' (replayed)'),
            'debug',
        );

        return { optimizedMessages: messages as unknown as OptimizeMessagesEvent['optimizedMessages'] };
    }
}