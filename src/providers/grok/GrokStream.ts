import type OpenAI from "openai";
import type { Stream } from "openai/streaming";
import * as vscode from "vscode";
import type { ModelUsageTokens } from "../VertexModelProvider";
import type { Logger } from "../../utils/Logger";

/**
 * Converts Vertex's OpenAI-compatible usage into the provider usage counters.
 *
 * The exact `xai/grok-4.6` path excludes cache hits from input and includes
 * separately reported reasoning in output. Other paths retain prompt and
 * completion counts without that adjustment.
 */
export function readGrokUsage(usage: OpenAI.CompletionUsage, modelPath: string): ModelUsageTokens {
    const input = usage.prompt_tokens ?? 0;
    const output = usage.completion_tokens ?? 0;
    const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;
    if (modelPath === "xai/grok-4.6") {
        // Google's Grok API reports reasoning separately from completion_tokens.
        // Prefer total - prompt to also handle servers that include it in completion.
        const reasoning = usage.completion_tokens_details?.reasoning_tokens ?? 0;
        return {
            input: Math.max(0, input - cached),
            output: Math.max(output, usage.total_tokens !== undefined ? usage.total_tokens - input : output + reasoning),
            cache_read: cached,
            cache_create: 0,
        };
    }
    return { input, output, cache_read: cached, cache_create: 0 };
}

/**
 * Reports first-choice text and assembled tool calls while collecting usage.
 *
 * Any finish reason flushes named calls with nonempty argument strings; malformed
 * JSON is logged and emitted as an empty object. Cancellation stops iteration,
 * after which the provider enforces request cancellation. If both usage counts
 * are zero, a stream's optional finalChatCompletion method is attempted.
 *
 * @remarks Character counters are updated in place. Tool calls left without a
 * finish reason are not emitted.
 */
export async function processGrokStream(
    stream: Stream<OpenAI.Chat.Completions.ChatCompletionChunk>,
    modelPath: string,
    charCount: { assistant_text: number; tool_use: number },
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
    logger: Logger,
): Promise<ModelUsageTokens> {
    // Accumulate tool call deltas (OpenAI streams tool calls incrementally)
    const toolAccumulator: Map<number, ToolCallAccumulator> = new Map();
    const tokenUsage = { input: 0, output: 0, cache_read: 0, cache_create: 0 };
    let chunkCount = 0;

    for await (const chunk of stream) {
        chunkCount++;
        if (token.isCancellationRequested) {
            logger.log(`  Cancelled after ${chunkCount} chunks`);
            break;
        }

        // Extract usage if present
        if (chunk.usage) {
            Object.assign(tokenUsage, readGrokUsage(chunk.usage, modelPath));
        }

        const delta = chunk.choices?.[0]?.delta;
        if (!delta) {
            continue;
        }

        // Grok returns final content; reasoning is accounted for in usage.
        const content = delta.content as string | undefined;

        if (content) {
            charCount.assistant_text += content.length;
            progress.report(new vscode.LanguageModelTextPart(content));
        }

        if (delta.tool_calls) {
            accumulateToolCalls(delta.tool_calls, toolAccumulator);
        }

        // Check finish_reason — when the model finishes, emit any complete tool calls
        const finishReason = chunk.choices?.[0]?.finish_reason;
        if (finishReason) {
            reportToolCalls(toolAccumulator, charCount, progress, logger);
            toolAccumulator.clear();
        }
    }

    // If stream ended without usage (e.g., cancelled), try to get final usage
    if (tokenUsage.input === 0 && tokenUsage.output === 0) {
        try {
            // ChatCompletionStream (openai/lib/ChatCompletionStream) has finalChatCompletion(),
            // but the raw Stream<ChatCompletionChunk> from openai/streaming does not.
            const s = stream as any;
            if (typeof s.finalChatCompletion === "function") {
                const completion = await s.finalChatCompletion();
                if (completion.usage) {
                    Object.assign(tokenUsage, readGrokUsage(completion.usage, modelPath));
                }
            } else {
                logger.log(`  ⚠️  Stream type does not support finalChatCompletion — usage may be incomplete`);
            }
        } catch {
            // finalChatCompletion may throw if stream was interrupted
            logger.log(`  ⚠️  Could not retrieve final chat completion for usage`);
        }
    }

    logger.log(`  ✅ Stream finished — ${chunkCount} chunks total, input=${tokenUsage.input}, output=${tokenUsage.output}`);
    return tokenUsage;
}

interface ToolCallAccumulator {
    id: string;
    name: string;
    json: string;
}

/** Appends argument fragments by stream index, updating IDs and names when present. */
function accumulateToolCalls(deltas: OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta.ToolCall[], toolAccumulator: Map<number, ToolCallAccumulator>): void {
    for (const tc of deltas) {
        const idx = tc.index;
        if (!toolAccumulator.has(idx)) {
            toolAccumulator.set(idx, { id: tc.id ?? "", name: "", json: "" });
        }
        const acc = toolAccumulator.get(idx)!;
        if (tc.id) {
            acc.id = tc.id;
        }
        if (tc.function?.name) {
            acc.name = tc.function.name;
        }
        if (tc.function?.arguments) {
            acc.json += tc.function.arguments;
        }
    }
}

/** Reports named calls with argument text using the existing JSON fallback behavior. */
function reportToolCalls(toolAccumulator: Map<number, ToolCallAccumulator>, charCount: { tool_use: number }, progress: vscode.Progress<vscode.LanguageModelResponsePart>, logger: Logger): void {
    for (const [
        ,
        acc,
    ] of toolAccumulator) {
        if (acc.name && acc.json) {
            let parsedInput = {};
            try {
                parsedInput = JSON.parse(acc.json);
            } catch {
                // Partial JSON at stream end — still emit what we have
                logger.log(`  ⚠️  Incomplete tool call JSON for ${acc.name}: ${acc.json.slice(0, 200)}`);
            }
            charCount.tool_use += acc.json.length + acc.name.length;
            progress.report(new vscode.LanguageModelToolCallPart(acc.id, acc.name, parsedInput));
            logger.log(`  🔧 Tool call emitted: ${acc.name}(${acc.json.slice(0, 100)}…)`);
        }
    }
}
