# docs/providers.md

> **Overview**
> This module contains the provider implementations that bridge VS Code's Language Model API with Vertex AI backend services. It handles authentication via Application Default Credentials, model discovery, and the transformation of VS Code's chat protocol into provider-specific payloads (Anthropic/Google).

## Table of Contents
- [Table of Contents](#table-of-contents)
- [Core Concepts](#core-concepts)
- [API Reference](#api-reference)
    - [VertexAnthropicProvider](#vertexanthropicprovider)
        - [initialize](#initialize)
        - [pingModel](#pingmodel)
        - [provideTokenCount](#providetokencount)
        - [provideLanguageModelChatResponse](#providelanguagemodelchatresponse)
    - [VertexGoogleProvider](#vertexgoogleprovider)
        - [initialize](#initialize-1)
        - [pingModel](#pingmodel-1)
        - [provideTokenCount](#providetokencount-1)
        - [provideLanguageModelChatResponse](#providelanguagemodelchatresponse-1)
- [Examples](#examples)

---

## Core Concepts
The provider architecture uses a unified `VertexModelProvider` interface to support multiple model families. 

- **Google Gemini Integration**: Managed by `VertexGoogleProvider`, supporting Gemini 3 Flash and 3.1 Pro models.
- **Anthropic Claude Integration**: Managed by `VertexAnthropicProvider`, supporting Claude Opus, Sonnet, and Haiku models (including versions 3, 3.5, and 4.x).
- **Thinking Models**: Specialized support for "High Thinking" models via model ID suffixes (e.g., `-high`), which triggers specific `thinkingConfig` parameters.
- **Thought Signatures**: A mechanism to maintain reasoning continuity across conversational turns by caching and re-injecting signatures into the message history.
- **Parallel Tool Execution**: Implementation of tool call buffering and message merging to satisfy Gemini's requirements for grouped function responses.
- **Prompt Caching (Ephemeral)**: Automated caching strategy for Anthropic models to reduce latency and costs for long conversations by marking system prompts, tools, and long conversation histories for ephemeral caching.

## API Reference

### VertexAnthropicProvider
[source](../src/providers/VertexAnthropicProvider.ts)
The `VertexAnthropicProvider` class implements the `VertexModelProvider` interface for Anthropic Claude models on Vertex AI. It utilizes the `@anthropic-ai/vertex-sdk` and includes sophisticated logic for automated prompt caching and multimodal message transformation.

#### initialize
[source](../src/providers/VertexAnthropicProvider.ts)
`initialize(projectId: string, region: string): void`

Sets the GCP Project ID and regional endpoint for the Anthropic Vertex client.

#### pingModel
[source](../src/providers/VertexAnthropicProvider.ts)
`pingModel(modelId: string): Promise<boolean>`

Sends a minimal "ping" message with `max_tokens: 1` to verify the availability of the specified Claude model in the configured project and region.

#### provideTokenCount
[source](../src/providers/VertexAnthropicProvider.ts)
`provideTokenCount(text: string | vscode.LanguageModelChatRequestMessage, _token: vscode.CancellationToken): Promise<number>`

Estimates token usage using a 4-characters-per-token heuristic for text strings or message objects.

#### provideLanguageModelChatResponse
[source](../src/providers/VertexAnthropicProvider.ts)
`provideLanguageModelChatResponse(modelId: string, messages: readonly vscode.LanguageModelChatRequestMessage[], options: vscode.ProvideLanguageModelChatResponseOptions, progress: vscode.Progress<vscode.LanguageModelResponsePart>, token: vscode.CancellationToken): Promise<ChatInferenceResult>`

Handles chat inference for Anthropic models. This method:
1. Maps VS Code messages to the Anthropic `messages` format, including support for `LanguageModelTextPart`, `LanguageModelToolCallPart`, `LanguageModelToolResultPart`, and `LanguageModelDataPart` (images and non-image data decoding).
2. Extracts system instructions from the message history to pass as top-level `system` blocks.
3. Automatically applies cache control strategies:
    - **Static Prefix Caching**: Applies `ephemeral` caching to the system blocks or tool definitions.
    - **Chat History Caching**: Applies `ephemeral` caching to the second-to-last message in the history if the total history exceeds 1024 tokens.
4. Manages streaming responses, reporting text deltas and tool call progress to VS Code.
5. Captures and returns detailed usage statistics, including `input`, `output`, `cache_read`, and `cache_create` token metrics, alongside character-level consumption for different part types.

### VertexGoogleProvider
[source](../src/providers/VertexGoogleProvider.ts)
The `VertexGoogleProvider` class implements the `VertexModelProvider` interface for Google Gemini models hosted on Vertex AI. It manages the lifecycle of the `@google/genai` client and handles the complexities of Gemini-specific features like thinking signatures and parallel tool calls.

#### initialize
[source](../src/providers/VertexGoogleProvider.ts)
`initialize(projectId: string, region: string): void`

Sets the GCP Project ID and regional endpoint (e.g., `us-central1`) for the provider.

#### pingModel
[source](../src/providers/VertexGoogleProvider.ts)
`pingModel(modelId: string): Promise<boolean>`

Attempts a minimal request to the specified model ID to verify availability and permissions in the current GCP project. It automatically resolves high-thinking model IDs to their base counterparts for the ping.

#### provideTokenCount
[source](../src/providers/VertexGoogleProvider.ts)
`provideTokenCount(text: string | vscode.LanguageModelChatRequestMessage, _token: vscode.CancellationToken): Promise<number>`

Provides a rough estimation of token usage. For text or message objects, it computes the count based on a 4-characters-per-token heuristic.

#### provideLanguageModelChatResponse
[source](../src/providers/VertexGoogleProvider.ts)
`provideLanguageModelChatResponse(modelId: string, messages: readonly vscode.LanguageModelChatRequestMessage[], options: vscode.ProvideLanguageModelChatResponseOptions, progress: vscode.Progress<vscode.LanguageModelResponsePart>, token: vscode.CancellationToken): Promise<ChatInferenceResult>`

Main entry point for chat inference. This method:
1. Maps VS Code messages to the Gemini `contents` format, including support for multimodal `LanguageModelDataPart` (images and non-image data decoding).
2. **Sanitizes tool input schemas** by recursively removing unsupported keys like `enumDescriptions` and `examples` from tool definitions to ensure compatibility with the Vertex AI Gemini API.
3. Re-injects cached thought signatures into the conversation history for both **assistant text parts** and **tool call parts** to preserve reasoning quality.
4. Merges consecutive tool result messages into a single user turn to satisfy Gemini API requirements for parallel tool calls.
5. **Normalizes tool results** into JSON objects, wrapping primitive return values to comply with Gemini's `google.protobuf.Struct` requirement for function responses.
6. Handles streaming responses, capturing text, tool calls, and capturing `thoughtSignature` from chunk metadata (supporting both legacy Gemini 2.x and inline Gemini 3 forms).
7. Buffers parallel tool calls across the stream to ensure they are emitted to VS Code as a single atomic step, preventing turn-mismatch errors.
8. Updates internal signature caches for both text reasoning (using a text-prefix key) and tool calls (using unique call IDs).
9. Tracks and returns detailed usage statistics including character counts and token usage metadata (input, output, and cache metrics). For Gemini, it correctly adjusts input tokens by subtracting cached content tokens to ensure accurate usage tracking.

## Examples