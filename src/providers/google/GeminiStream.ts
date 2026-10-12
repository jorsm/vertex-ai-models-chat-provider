import * as vscode from "vscode";
import type { Logger } from "../../utils/Logger";
import type { CharacterCounts } from "../VertexModelProvider";
import type { GeminiReasoningHeaders } from "./GeminiMessages";

/** Provider-owned state and response sinks borrowed for one Gemini stream. */
export interface GeminiStreamContext {
    /** Configured VS Code model ID used when recognizing reasoning headers. */
    modelId: string;
    /** Resolved Vertex model ID used by the same header filter. */
    actualId: string;
    progress: vscode.Progress<vscode.LanguageModelResponsePart>;
    /** Running request counters updated when answer text is reported. */
    charCount: CharacterCounts;
    logger: Logger;
    signal: AbortSignal;
    /** Provider-owned tool-call cache; receives signatures keyed by generated call ID. */
    thoughtSignatureCache: Map<string, string>;
    /** Provider-owned text cache; receives signatures keyed by the first 120 answer characters. */
    textSignatureCache: Map<string, string>;
    reasoningHeaders: GeminiReasoningHeaders;
}

/** Latest prompt, candidate, and cache counters reported by the stream. */
export interface GeminiStreamUsage {
    inputTokens: number;
    outputTokens: number;
    cacheRead: number;
}

/**
 * Reports answer text as it arrives and emits collected function calls after the stream.
 *
 * @remarks
 * Inline signatures remain indexed by function name within each chunk, with a pending
 * preceding signature as fallback. Signature caches are updated only after the final
 * cancellation check. Token fields carry forward when later chunks omit them.
 */
export async function processGeminiStream(stream: AsyncIterable<any>, context: GeminiStreamContext): Promise<GeminiStreamUsage> {
    const { modelId, actualId, progress, charCount, logger, signal, thoughtSignatureCache, textSignatureCache, reasoningHeaders } = context;
    let inputTokens = 0,
        outputTokens = 0,
        cacheRead = 0;
    const processor = new StreamPartProcessor(reasoningHeaders, modelId, actualId, progress, charCount, logger);
    const bufferedCalls: Array<{ callId: string; callName: string; args: any; signature: string | undefined }> = [];

    for await (const chunk of stream) {
        if (signal.aborted) {
            throw new vscode.CancellationError();
        }

        const rawParts: any[] | undefined = chunk.candidates?.[0]?.content?.parts;
        const inlineSignatureByName = new Map<string, string>();

        if (rawParts) {
            logRawParts(rawParts, logger);
            processor.processRawParts(rawParts, inlineSignatureByName);
        }

        const functionCalls = chunk.functionCalls;
        if (functionCalls && functionCalls.length > 0) {
            for (const fc of functionCalls) {
                const callName = fc.name || "unknown";
                const callId = `${callName}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
                const signature = inlineSignatureByName.get(callName) ?? processor.pendingThoughtSignature;
                logger.log(`  🔧 FunctionCall buffered: name=${callName} callId=${callId} inlineSig=${inlineSignatureByName.has(callName)} pendingSig=${!!processor.pendingThoughtSignature}`);
                bufferedCalls.push({ callId, callName, args: fc.args ?? {}, signature });
            }
            processor.pendingThoughtSignature = undefined;
        }

        if (chunk.usageMetadata) {
            inputTokens = chunk.usageMetadata.promptTokenCount ?? inputTokens;
            outputTokens = chunk.usageMetadata.candidatesTokenCount ?? outputTokens;
            cacheRead = chunk.usageMetadata.cachedContentTokenCount ?? cacheRead;
        }
    }

    if (signal.aborted) {
        throw new vscode.CancellationError();
    }
    // Emit all buffered function calls together so VS Code groups them into
    // a single model turn, matching the API's parallel-call expectations.
    if (bufferedCalls.length > 0) {
        logger.log(`  🔧 Emitting ${bufferedCalls.length} buffered function call(s)`);
        for (const { callId, callName, args, signature } of bufferedCalls) {
            if (signature) {
                thoughtSignatureCache.set(callId, signature);
                logger.log(`    💾 Cached thought signature for callId=${callId} (${signature.length} chars)`);
            } else {
                logger.log(`    ⚠️  No thought signature for callId=${callId}`);
            }
            progress.report(new vscode.LanguageModelToolCallPart(callId, callName, args));
        }
    }

    // Cache the text signature against the clean answer text so it can be re-attached in history.
    if (processor.latestTextSignature && processor.accumulatedAnswerText.length > 0) {
        const textKey = processor.accumulatedAnswerText.substring(0, 120);
        textSignatureCache.set(textKey, processor.latestTextSignature);
        logger.log(`    📝 Cached text thought signature for answer turn (${processor.latestTextSignature.length} chars)`);
    }

    logger.log(`  ✅ Stream finished successfully`);

    return { inputTokens, outputTokens, cacheRead };
}

function logRawParts(rawParts: any[], logger: Logger): void {
    logger.log(
        `  🧩 Chunk rawParts[${rawParts.length}]: ${rawParts
            .map((p: any) => {
                if (p.thought) {
                    return `thought(sig=${!!p.thoughtSignature},len=${p.thoughtSignature?.length ?? 0})`;
                }
                if (p.functionCall) {
                    return `functionCall(${p.functionCall.name},inlineSig=${!!p.thoughtSignature})`;
                }
                if (p.functionResponse) {
                    return `functionResponse(${p.functionResponse.name})`;
                }
                if (p.text !== undefined) {
                    return `text(${p.text.length},sig=${!!p.thoughtSignature})`;
                }
                return JSON.stringify(Object.keys(p));
            })
            .join(", ")}`,
    );
}

/**
 * Stateful helper class responsible for parsing raw candidate parts from the Google/Vertex AI stream.
 * It is specifically designed to isolate legacy and inline cryptographic `thoughtSignature` parameters,
 * while automatically detecting and stripping multi-chunk leaked reasoning blocks in high-thinking models.
 */
class StreamPartProcessor {
    /** Preceding signature available until the next chunk containing function calls. */
    public pendingThoughtSignature: string | undefined;
    /** Latest preceding or non-thought text signature captured from raw parts. */
    public latestTextSignature: string | undefined;
    /** Answer text already reported, used to form the text-signature cache key. */
    public accumulatedAnswerText = "";
    private inLeakedReasoning = false;

    constructor(
        private readonly provider: GeminiReasoningHeaders,
        private readonly modelId: string,
        private readonly actualId: string,
        private readonly progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        private readonly charCount: CharacterCounts,
        private readonly logger: Logger,
    ) {}

    /**
     * Processes all raw candidate parts in a single stream chunk.
     * Extracts thought signatures and handles skipping/reporting of text chunks.
     *
     * @param rawParts - The raw part objects array returned by the API.
     * @param inlineSignatureByName - A map to associate inline signatures with tool call names.
     */
    public processRawParts(rawParts: any[], inlineSignatureByName: Map<string, string>): void {
        for (const part of rawParts) {
            this.extractSignatures(part, inlineSignatureByName);
            this.processTextPart(part);
        }
    }

    /**
     * Identifies and stores any legacy (preceding thought part) or inline thought signatures
     * present on the given part so they can be cached and re-injected in later history turns.
     *
     * @param part - The raw part object being inspected.
     * @param inlineSignatureByName - A map to associate inline signatures with tool call names.
     */
    private extractSignatures(part: any, inlineSignatureByName: Map<string, string>): void {
        // Legacy: separate thought part with signature (Gemini 2.x thinking)
        if (part.thought === true && part.thoughtSignature) {
            this.pendingThoughtSignature = part.thoughtSignature;
            this.latestTextSignature = part.thoughtSignature;
            this.logger.log(`    ✍️  Captured preceding thought signature (${part.thoughtSignature.length} chars)`);
        }
        // Gemini 3: signature embedded directly on the functionCall part
        if (part.functionCall?.name && part.thoughtSignature) {
            inlineSignatureByName.set(part.functionCall.name, part.thoughtSignature);
            this.logger.log(`    ✍️  Captured inline thought signature for ${part.functionCall.name} (${part.thoughtSignature.length} chars)`);
        }
        // Capture optional signature on final text parts (non-functionCall turns)
        if (part.text !== undefined && part.thoughtSignature && !part.thought) {
            this.latestTextSignature = part.thoughtSignature;
        }
    }

    /**
     * Filters explicit thought parts and recognized reasoning headers before reporting text.
     * Header filtering carries across chunks until the first newline.
     *
     * @param part - The raw part containing a text property.
     */
    private processTextPart(part: any): void {
        if (part.text === undefined) {
            return;
        }

        if (part.thought) {
            this.logger.log(`    🧠 Skipping reasoning text part (${part.text.length} chars)`);
            return;
        }

        // Skip streamed leaked reasoning chunks if we are already in skipping state
        if (this.inLeakedReasoning) {
            this.handleStreamingLeakedReasoning(part.text);
            return;
        }

        // Detect if this part is the start of a leaked reasoning block
        if (part.thoughtSignature && this.provider.isLeakedReasoningHeader(part.text, this.modelId, this.actualId)) {
            this.logger.log(`    🧠 Detected leaked reasoning block starting for ${this.modelId}`);
            this.handleLeakedReasoningStart(part.text);
            return;
        }

        // Normal text part: report it
        this.emitText(part.text);
    }

    /**
     * Process a streamed leaked reasoning chunk when already in a skipping state.
     * Keeps skipping text until a newline is found, indicating the end of the metadata block.
     *
     * @param text - The current raw text chunk.
     */
    private handleStreamingLeakedReasoning(text: string): void {
        const newlineIdx = text.indexOf("\n");
        if (newlineIdx !== -1) {
            this.inLeakedReasoning = false;
            const realText = text.substring(newlineIdx + 1);
            if (realText.length > 0) {
                this.emitText(realText);
            }
        } else {
            this.logger.log(`    🧠 Skipping streamed leaked reasoning chunk (${text.length} chars)`);
        }
    }

    /**
     * Handles the first chunk of a detected leaked reasoning block.
     * If the block contains a newline, it strips the prefix and emits the remaining text.
     * Otherwise, it transitions the processor into the `inLeakedReasoning` skipping state.
     *
     * @param text - The current raw text chunk that started with the leaked signature prefix.
     */
    private handleLeakedReasoningStart(text: string): void {
        const newlineIdx = text.indexOf("\n");
        if (newlineIdx !== -1) {
            const realText = text.substring(newlineIdx + 1);
            if (realText.length > 0) {
                this.emitText(realText);
            }
        } else {
            this.inLeakedReasoning = true;
        }
    }

    /**
     * Reports clean, non-metadata answer text back to the VS Code UI and increments
     * assistant character count tracking metrics.
     *
     * @param text - The clean text to emit.
     */
    private emitText(text: string): void {
        this.accumulatedAnswerText += text;
        this.progress.report(new vscode.LanguageModelTextPart(text));
        this.charCount.assistant_text += text.length;
    }
}
