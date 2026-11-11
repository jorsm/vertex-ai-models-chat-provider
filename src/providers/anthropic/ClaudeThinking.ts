import { createHash, Hash } from "node:crypto";

/**
 * Builds adaptive-thinking options with the caller's literal effort value.
 *
 * @remarks Thinking display is omitted; signed blocks are still accumulated for
 * tool continuations by {@link ClaudeStreamContentAccumulator}.
 */
export function claudeEffortConfig(effort: string) {
    return { thinking: { type: "adaptive" as const, display: "omitted" as const }, output_config: { effort } };
}

/** Supported content blocks retained for an assistant tool-use continuation. */
export type ClaudeReplayBlock = { type: "thinking"; thinking: string; signature: string } | { type: "redacted_thinking"; data: string } | { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: object };

/** Mutable assembly state for one indexed content block. */
interface StreamBlockState {
    block: ClaudeReplayBlock;
    inputJson?: string;
    stopped: boolean;
    valid: boolean;
}

/** A complete signed assistant turn and its tool-continuation lookup keys. */
export interface ClaudeThinkingReplay {
    /** Content in original stream-index order, including visible and signed blocks. */
    blocks: ClaudeReplayBlock[];
    /** IDs of tool blocks with nonempty IDs and names. */
    toolCallIds: string[];
}

/**
 * Reassembles Claude's streamed content blocks in their original index order.
 *
 * @remarks
 * This class accumulates content without publishing response parts. The provider
 * uses visible blocks for responses and retains signed blocks so a tool-use
 * continuation can send the completed assistant turn back unchanged.
 */
export class ClaudeStreamContentAccumulator {
    private readonly states = new Map<number, StreamBlockState>();

    /**
     * Starts a recognized block at its stream index, replacing any prior state.
     *
     * @remarks Unknown block types are ignored. Tool input must be an object;
     * otherwise the initial input is an empty object.
     */
    start(index: number, contentBlock: any): void {
        let block: ClaudeReplayBlock | undefined;

        if (contentBlock?.type === "thinking") {
            block = {
                type: "thinking",
                thinking: contentBlock.thinking ?? "",
                signature: contentBlock.signature ?? "",
            };
        } else if (contentBlock?.type === "redacted_thinking") {
            block = { type: "redacted_thinking", data: contentBlock.data ?? "" };
        } else if (contentBlock?.type === "text") {
            block = { type: "text", text: contentBlock.text ?? "" };
        } else if (contentBlock?.type === "tool_use") {
            block = {
                type: "tool_use",
                id: contentBlock.id ?? "",
                name: contentBlock.name ?? "",
                input: typeof contentBlock.input === "object" && contentBlock.input !== null && !Array.isArray(contentBlock.input) ? contentBlock.input : {},
            };
        }

        if (block) {
            this.states.set(index, {
                block,
                ...(block.type === "tool_use" ? { inputJson: "" } : {}),
                stopped: false,
                valid: true,
            });
        }
    }

    /** Appends matching text, thinking, signature or tool-JSON deltas to a block. */
    delta(index: number, delta: any): void {
        const state = this.states.get(index);
        if (!state) {
            return;
        }

        if (state.block.type === "thinking" && delta?.type === "thinking_delta") {
            state.block.thinking += delta.thinking ?? "";
        } else if (state.block.type === "thinking" && delta?.type === "signature_delta") {
            state.block.signature += delta.signature ?? "";
        } else if (state.block.type === "text" && delta?.type === "text_delta") {
            state.block.text += delta.text ?? "";
        } else if (state.block.type === "tool_use" && delta?.type === "input_json_delta") {
            state.inputJson += delta.partial_json ?? "";
        }
    }

    /**
     * Finalizes a known block and returns a defensive JSON copy.
     *
     * @remarks Malformed or non-object tool JSON invalidates replay eligibility
     * while leaving the initial input in the returned block. Callers currently
     * emit that tool block; this behavior is recorded for a later decision.
     *
     * @returns Undefined when no recognized block was started at the index.
     */
    stop(index: number): ClaudeReplayBlock | undefined {
        const state = this.states.get(index);
        if (!state) {
            return undefined;
        }

        if (state.block.type === "tool_use" && state.inputJson) {
            try {
                const parsedInput: unknown = JSON.parse(state.inputJson);
                if (typeof parsedInput !== "object" || parsedInput === null || Array.isArray(parsedInput)) {
                    state.valid = false;
                } else {
                    state.block.input = parsedInput;
                }
            } catch {
                state.valid = false;
            }
        }
        state.stopped = true;
        return JSON.parse(JSON.stringify(state.block)) as ClaudeReplayBlock;
    }

    /**
     * Creates a replay only when every accumulated block is stopped and valid.
     *
     * @remarks Requires signed thinking or redacted data and at least one named
     * tool call with an ID. The returned blocks are copied in stream-index order.
     */
    createThinkingReplay(): ClaudeThinkingReplay | undefined {
        const orderedStates = [...this.states.entries()]
            .sort(([a], [b]) => a - b)
            .map(
                ([
                    ,
                    state,
                ]) => state,
            );
        if (orderedStates.length === 0 || orderedStates.some((state) => !state.stopped || !state.valid)) {
            return undefined;
        }

        const blocks = orderedStates.map((state) => state.block);
        const hasThinking = blocks.some((block) => block.type === "thinking" || block.type === "redacted_thinking");
        const thinkingIsComplete = blocks.every((block) => (block.type === "thinking" ? block.signature.length > 0 : block.type === "redacted_thinking" ? block.data.length > 0 : true));
        const toolCallIds = blocks.flatMap((block) => (block.type === "tool_use" && block.id.length > 0 && block.name.length > 0 ? [block.id] : []));

        if (!hasThinking || !thinkingIsComplete || toolCallIds.length === 0) {
            return undefined;
        }

        return { blocks: cloneReplayBlocks(blocks), toolCallIds };
    }
}

/**
 * Incrementally fingerprints the model, system prompt, tools and message prefix.
 *
 * @remarks The hash retains no copy of prompts, tool results or reasoning. Cache
 * markers are excluded without modifying the supplied blocks or tool inputs.
 */
export class ClaudeThinkingPrefix {
    private hash: Hash;

    /**
     * Starts a model/system/tool fingerprint, or adopts a supplied hash snapshot.
     *
     * @param hash - Internal snapshot used by {@link copy}.
     */
    constructor(model: string, system?: any[], tools?: any[], hash?: Hash) {
        this.hash =
            hash ??
            createHash("sha256").update(
                JSON.stringify({
                    model,
                    system: (system ?? []).map(withoutCacheMarker),
                    tools: (tools ?? []).map(withoutCacheMarker),
                }),
            );
    }

    /** Adds the message role and content, excluding transport cache markers. */
    append(message: any): void {
        this.hash.update(JSON.stringify({ role: message.role, content: message.content.map(withoutCacheMarker) }));
    }

    /** Returns an independent hash snapshot without retaining the source history. */
    copy(): ClaudeThinkingPrefix {
        return new ClaudeThinkingPrefix("", undefined, undefined, this.hash.copy());
    }

    /**
     * Hashes the prefix plus visible assistant blocks without consuming this hash.
     *
     * @remarks Thinking and redacted blocks are excluded so the same fingerprint
     * can validate mapped history before its signed replay has been restored.
     */
    fingerprint(assistantBlocks: readonly any[]): string {
        const visible = assistantBlocks.filter((block) => block.type !== "thinking" && block.type !== "redacted_thinking");
        const copy = this.copy();
        copy.append({ role: "assistant", content: visible });
        return copy.hash.digest("hex");
    }
}

type CachedReplay = ClaudeThinkingReplay & { prefixFingerprint: string | undefined };

/**
 * Keeps a bounded set of signed assistant turns for VS Code tool continuations.
 *
 * @remarks Replays are indexed by tool-call ID and copied on storage and lookup.
 * Matching requires the complete set of tool calls from one retained turn.
 */
export class ClaudeThinkingReplayCache {
    private readonly byToolCallId = new Map<string, CachedReplay>();
    private readonly turns: CachedReplay[] = [];

    /** @param maxTurns - Maximum number of retained assistant turns; defaults to 64. */
    constructor(private readonly maxTurns = 64) {}

    /** Stores a defensive copy and evicts oldest turns beyond the configured bound. */
    store(replay: ClaudeThinkingReplay, prefixFingerprint?: string): void {
        const cached: CachedReplay = {
            blocks: cloneReplayBlocks(replay.blocks),
            toolCallIds: [...replay.toolCallIds],
            prefixFingerprint,
        };
        this.turns.push(cached);
        for (const callId of cached.toolCallIds) {
            this.byToolCallId.set(callId, cached);
        }

        while (this.turns.length > this.maxTurns) {
            const evicted = this.turns.shift();
            if (!evicted) {
                break;
            }
            for (const callId of evicted.toolCallIds) {
                if (this.byToolCallId.get(callId) === evicted) {
                    this.byToolCallId.delete(callId);
                }
            }
        }
    }

    /**
     * Finds a retained turn by its complete tool-call set and optional fingerprint.
     *
     * @remarks A supplied fingerprint mismatch permanently removes that turn's
     * lookup entries. Matching blocks are returned as a defensive JSON copy.
     */
    find(toolCallIds: readonly string[], prefixFingerprint?: string): ClaudeReplayBlock[] | undefined {
        const requestedIds = new Set(toolCallIds);
        for (const callId of requestedIds) {
            const replay = this.byToolCallId.get(callId);
            if (replay && replay.toolCallIds.length === requestedIds.size && replay.toolCallIds.every((id) => requestedIds.has(id))) {
                if (prefixFingerprint !== undefined && replay.prefixFingerprint !== prefixFingerprint) {
                    // Never resurrect a block after its prefix changed, even if a later
                    // request happens to reconstruct the old context again.
                    for (const id of replay.toolCallIds) {
                        if (this.byToolCallId.get(id) === replay) {
                            this.byToolCallId.delete(id);
                        }
                    }
                    return undefined;
                }
                return cloneReplayBlocks(replay.blocks);
            }
        }
        return undefined;
    }
}

/** Creates the existing JSON copy used at replay storage/lookup boundaries. */
function cloneReplayBlocks(blocks: readonly ClaudeReplayBlock[]): ClaudeReplayBlock[] {
    return JSON.parse(JSON.stringify(blocks)) as ClaudeReplayBlock[];
}

/** Strips block-level cache markers while preserving actual tool-input fields. */
function withoutCacheMarker(block: any): any {
    const { cache_control: _cacheControl, ...rest } = block;
    if (rest.type === "tool_result" && Array.isArray(rest.content)) {
        rest.content = rest.content.map(withoutCacheMarker);
    }
    return rest;
}
