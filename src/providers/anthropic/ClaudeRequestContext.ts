import type { Logger } from "../../utils/Logger";
import { ClaudeThinkingPrefix, ClaudeThinkingReplayCache } from "../ClaudeThinking";

/**
 * Restores cached signed blocks when a tool turn still has its original prefix.
 *
 * @remarks
 * Mutates matching assistant messages before cache markers are added. A prefix
 * mismatch invalidates the replay through {@link ClaudeThinkingReplayCache.find}.
 * The returned prefix includes the complete mapped request history.
 */
export function restoreClaudeThinking(model: string, system: any[] | undefined, tools: any[] | undefined, messages: any[], replayCache: ClaudeThinkingReplayCache, logger: Logger): ClaudeThinkingPrefix {
    const prefix = new ClaudeThinkingPrefix(model, system, tools);
    for (const message of messages) {
        if (message.role === "assistant") {
            const ids = message.content.flatMap((block: any) => (block.type === "tool_use" ? [block.id] : []));
            const hadReplay = replayCache.find(ids) !== undefined;
            const blocks = replayCache.find(ids, prefix.fingerprint(message.content));
            if (blocks) {
                message.content = blocks;
                logger.log(`  Restored signed thinking for ${ids.length} tool call(s): prefix unchanged`);
            } else if (hadReplay) {
                logger.log(`  Discarded cached thinking for ${ids.length} tool call(s): context, tools or assistant content changed`);
            }
        }
        prefix.append(message);
    }
    return prefix;
}

/**
 * Adds the existing ephemeral cache markers to the mapped request in place.
 *
 * @remarks
 * Tools take priority over system blocks for prefix caching. History caching uses
 * the penultimate message only when the serialized history estimate exceeds
 * 1024 tokens. Marker placement must follow {@link restoreClaudeThinking}.
 */
export function applyClaudeCacheControl(tools: any[] | undefined, systemBlocks: any[] | undefined, mappedMessages: any[], logger: Logger): void {
    // 1. Static Prefix Caching (System / Tools)
    const prefixCached = applyPrefixCache(tools, systemBlocks);
    // 2. Chat History Caching (Messages)
    const { historyCached, historyTokens } = applyHistoryCache(mappedMessages);
    logger.log(`  Caching Strategy Applied: Prefix=${prefixCached}, History=${historyCached} (Estimated ${historyTokens} tokens)`);
}

/**
 * Marks the final tool, or otherwise the final system block, as ephemeral.
 */
function applyPrefixCache(tools: any[] | undefined, systemBlocks: any[] | undefined): boolean {
    if (tools && tools.length > 0) {
        tools.at(-1).cache_control = { type: "ephemeral" };
        return true;
    }
    if (systemBlocks && systemBlocks.length > 0) {
        systemBlocks.at(-1).cache_control = { type: "ephemeral" };
        return true;
    }
    return false;
}

/**
 * Estimates all messages except the last and optionally marks the prior block.
 */
function applyHistoryCache(mappedMessages: any[]): { historyCached: boolean; historyTokens: number } {
    let historyTokens = 0;
    for (let i = 0; i < mappedMessages.length - 1; i++) {
        historyTokens += Math.ceil(JSON.stringify(mappedMessages[i]).length / 4);
    }
    if (historyTokens > 1024 && mappedMessages.length > 1) {
        const secondToLast = mappedMessages.at(-2);
        if (secondToLast?.content?.length > 0) {
            secondToLast.content.at(-1).cache_control = { type: "ephemeral" };
            return { historyCached: true, historyTokens };
        }
    }
    return { historyCached: false, historyTokens };
}
