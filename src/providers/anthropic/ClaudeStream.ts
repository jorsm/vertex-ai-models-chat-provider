import * as vscode from "vscode";
import type { Logger } from "../../utils/Logger";
import type { CharacterCounts, ModelUsageTokens } from "../VertexModelProvider";
import { ClaudeStreamContentAccumulator, ClaudeThinkingReplayCache, ClaudeThinkingPrefix } from "../ClaudeThinking";

type StreamCharacterCounts = Pick<CharacterCounts, "assistant_text" | "tool_use">;

/**
 * Streams visible text/tool calls and retains completed signed tool turns.
 *
 * @remarks
 * Abort signals throw a VS Code cancellation error. A requested cancellation
 * token stops consumption and prevents replay storage. Thinking blocks stay in
 * {@link ClaudeStreamContentAccumulator}, and never become response parts.
 *
 * @returns The latest usage values supplied by Claude message events.
 */
export async function processClaudeStream(
    stream: AsyncIterable<any>,
    charCount: StreamCharacterCounts,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
    replayCache: ClaudeThinkingReplayCache,
    logger: Logger,
    signal?: AbortSignal,
    thinkingPrefix?: ClaudeThinkingPrefix,
): Promise<ModelUsageTokens> {
    const contentAccumulator = new ClaudeStreamContentAccumulator();
    const tokenUsage = { input: 0, output: 0, cache_read: 0, cache_create: 0 };
    let chunkCount = 0;
    let cancelled = false;
    for await (const chunk of stream) {
        if (signal?.aborted) {
            throw new vscode.CancellationError();
        }
        chunkCount++;
        if (token.isCancellationRequested) {
            logger.log(`  Cancelled after ${chunkCount} chunks`);
            cancelled = true;
            break;
        }
        handleClaudeStreamChunk(chunk, charCount, progress, contentAccumulator, tokenUsage, logger);
    }
    if (signal?.aborted) {
        throw new vscode.CancellationError();
    }
    if (!cancelled) {
        const replay = contentAccumulator.createThinkingReplay();
        if (replay) {
            replayCache.store(replay, thinkingPrefix?.fingerprint(replay.blocks));
            const hiddenBlockCount = replay.blocks.filter((block) => block.type === "thinking" || block.type === "redacted_thinking").length;
            logger.log(`  🔒 Retained ${hiddenBlockCount} signed thinking block(s) for ${replay.toolCallIds.length} tool continuation(s)`);
        }
    }
    logger.log(`  ✅ Stream finished — ${chunkCount} chunks total`);
    return tokenUsage;
}

/**
 * Applies one SDK event to usage, attribution, emitted parts and replay state.
 *
 * @remarks Tool blocks are emitted on stop even when their JSON made the replay
 * invalid; this existing behavior is deferred in `docs/providers-follow-up.md`.
 */
function handleClaudeStreamChunk(chunk: any, charCount: StreamCharacterCounts, progress: vscode.Progress<vscode.LanguageModelResponsePart>, contentAccumulator: ClaudeStreamContentAccumulator, tokenUsage: ModelUsageTokens, logger: Logger): void {
    if (chunk.type === "message_start") {
        const usage = chunk.message?.usage;
        if (usage) {
            tokenUsage.input = usage.input_tokens ?? 0;
            tokenUsage.cache_read = usage.cache_read_input_tokens ?? 0;
            tokenUsage.cache_create = usage.cache_creation_input_tokens ?? 0;
            logger.log(`  📊 Input tokens: ${tokenUsage.input}, cache_read: ${tokenUsage.cache_read}, cache_create: ${tokenUsage.cache_create}`);
        }
    } else if (chunk.type === "message_delta") {
        const usage = chunk.usage;
        if (usage) {
            tokenUsage.output = usage.output_tokens ?? 0;
            logger.log(`  📊 Output tokens: ${tokenUsage.output}`);
        }
    } else if (chunk.type === "content_block_start") {
        contentAccumulator.start(chunk.index, chunk.content_block);
    } else if (chunk.type === "content_block_delta") {
        contentAccumulator.delta(chunk.index, chunk.delta);
        if (chunk.delta.type === "text_delta") {
            charCount.assistant_text += chunk.delta.text.length;
            progress.report(new vscode.LanguageModelTextPart(chunk.delta.text));
        } else if (chunk.delta.type === "input_json_delta") {
            charCount.tool_use += chunk.delta.partial_json.length;
        }
    } else if (chunk.type === "content_block_stop") {
        const completedBlock = contentAccumulator.stop(chunk.index);
        if (completedBlock?.type === "tool_use") {
            progress.report(new vscode.LanguageModelToolCallPart(completedBlock.id, completedBlock.name, completedBlock.input));
        }
    }
}
