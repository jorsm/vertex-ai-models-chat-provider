export const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

export type ClaudeEffort = (typeof CLAUDE_EFFORTS)[number];

export interface ClaudeModelResolution {
  actualId: string;
  effort?: ClaudeEffort;
  requestConfig?: {
    thinking: { type: "adaptive"; display: "omitted" };
    output_config: { effort: ClaudeEffort };
  };
}

/**
 * Treats a recognized trailing effort level as an extension-only model alias.
 * The convention works for bundled and custom catalog entries without tying
 * effort support to a hard-coded list of Claude model names.
 */
export function resolveClaudeModelId(modelId: string): ClaudeModelResolution {
  const match = /-(low|medium|high|xhigh|max)$/.exec(modelId);
  if (!match) {
    return { actualId: modelId };
  }

  const effort = match[1] as ClaudeEffort;
  return {
    actualId: modelId.slice(0, -match[0].length),
    effort,
    requestConfig: {
      thinking: { type: "adaptive", display: "omitted" },
      output_config: { effort },
    },
  };
}

export type ClaudeReplayBlock =
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "redacted_thinking"; data: string }
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: object };

interface StreamBlockState {
  block: ClaudeReplayBlock;
  inputJson?: string;
  stopped: boolean;
  valid: boolean;
}

export interface ClaudeThinkingReplay {
  blocks: ClaudeReplayBlock[];
  toolCallIds: string[];
}

function cloneReplayBlocks(blocks: readonly ClaudeReplayBlock[]): ClaudeReplayBlock[] {
  return JSON.parse(JSON.stringify(blocks)) as ClaudeReplayBlock[];
}

/**
 * Reassembles Claude's streamed content blocks in their original index order.
 * Thinking content is never exposed by this class; it is retained only so a
 * tool-use continuation can send the exact signed blocks back to Claude.
 */
export class ClaudeStreamContentAccumulator {
  private readonly states = new Map<number, StreamBlockState>();

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

  createThinkingReplay(): ClaudeThinkingReplay | undefined {
    const orderedStates = [...this.states.entries()].sort(([a], [b]) => a - b).map(([, state]) => state);
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

type CachedReplay = ClaudeThinkingReplay;

/** Keeps a bounded set of signed assistant turns for VS Code tool continuations. */
export class ClaudeThinkingReplayCache {
  private readonly byToolCallId = new Map<string, CachedReplay>();
  private readonly turns: CachedReplay[] = [];

  constructor(private readonly maxTurns = 64) {}

  store(replay: ClaudeThinkingReplay): void {
    const cached: CachedReplay = {
      blocks: cloneReplayBlocks(replay.blocks),
      toolCallIds: [...replay.toolCallIds],
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

  find(toolCallIds: readonly string[]): ClaudeReplayBlock[] | undefined {
    const requestedIds = new Set(toolCallIds);
    for (const callId of requestedIds) {
      const replay = this.byToolCallId.get(callId);
      if (replay && replay.toolCallIds.length === requestedIds.size && replay.toolCallIds.every((id) => requestedIds.has(id))) {
        return cloneReplayBlocks(replay.blocks);
      }
    }
    return undefined;
  }
}
