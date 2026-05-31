# docs/providers.md

> **Overview**
> This module contains the provider implementations that bridge VS Code's Language Model API with Vertex AI backend services. It handles authentication via Application Default Credentials, model discovery, and the transformation of VS Code's chat protocol into provider-specific payloads (Anthropic/Google).

## Table of Contents
- [Table of Contents](#table-of-contents)
- [Core Concepts](#core-concepts)
- [API Reference](#api-reference)
    - [VertexAnthropicProvider](#vertexanthropicprovider)
        - [initialize](#initialize)
        - [setLabels](#setlabels)
        - [pingModel](#pingmodel)
        - [provideTokenCount](#providetokencount)
        - [provideLanguageModelChatResponse](#providelanguagemodelchatresponse)
    - [VertexGoogleProvider](#vertexgoogleprovider)
        - [initialize](#initialize-1)
        - [setLabels](#setlabels-1)
        - [pingModel](#pingmodel-1)
        - [provideTokenCount](#providetokencount-1)
        - [isLeakedReasoningHeader](#isleakedreasoningheader)
        - [stripLeakedReasoningHeader](#stripleakedreasoningheader)
        - [provideLanguageModelChatResponse](#providelanguagemodelchatresponse-1)
    - [VertexMaaSProvider](#vertexmaasprovider)
        - [initialize](#initialize-2)
        - [setLabels](#setlabels-2)
        - [pingModel](#pingmodel-2)
        - [provideTokenCount](#providetokencount-2)
        - [provideLanguageModelChatResponse](#providelanguagemodelchatresponse-2)
- [Examples](#examples)

---

## Core Concepts
The provider architecture uses a unified `VertexModelProvider` interface to support multiple model families. 

- **Google Gemini Integration**: Managed by `VertexGoogleProvider`, supporting Gemini 3 Flash and 3.1 Pro models.
- **Anthropic Claude Integration**: Managed by `VertexAnthropicProvider`, supporting Claude Opus, Sonnet, and Haiku models (including versions 3, 3.5, and 4.x).
- **Models-as-a-Service (MaaS)**: Managed by `VertexMaaSProvider`, providing access to third-party models like DeepSeek-V3.2, Qwen 3 Coder, and Kimi K2 through an OpenAI-compatible Vertex AI endpoint.
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
`initialize(projectId: string, region: string, authOptions?: any): void`

Sets the GCP Project ID and regional endpoint for the Anthropic Vertex client. If provided, `authOptions` are used to configure the underlying `GoogleAuth` instance with the necessary cloud-platform scopes.

#### setLabels
[source](../src/providers/VertexAnthropicProvider.ts)
`setLabels(labels: Record<string, string>): void`

Updates the internal labels mapping. These labels are logged and included in request metadata where supported to facilitate cost tracking and resource labeling in the Google Cloud Console.

#### pingModel
[source](../src/providers/VertexAnthropicProvider.ts)
`pingModel(modelId: string): Promise<boolean>`

Sends a minimal "ping" message with `max_tokens: 1` to verify the availability of the specified Claude model in the configured project and region. It handles transient rate-limiting errors (429) gracefully, treating them as confirmation that the model is reachable and available.

#### provideTokenCount
[source](../src/providers/VertexAnthropicProvider.ts)
`provideTokenCount(text: string | vscode.LanguageModelChatRequestMessage, _token: vscode.CancellationToken): Promise<number>`

Estimates token usage using a 4-characters-per-token heuristic for text strings or message objects via the `estimateTokens` utility.

#### provideLanguageModelChatResponse
[source](../src/providers/VertexAnthropicProvider.ts)
`provideLanguageModelChatResponse(modelId: string, messages: readonly vscode.LanguageModelChatRequestMessage[], options: vscode.ProvideLanguageModelChatResponseOptions, progress: vscode.Progress<vscode.LanguageModelResponsePart>, token: vscode.CancellationToken, labels?: Record<string, string>): Promise<ChatInferenceResult>`

Handles chat inference for Anthropic models. This method:
1. Maps VS Code messages to the Anthropic `messages` format, supporting `LanguageModelTextPart`, `LanguageModelToolCallPart`, `LanguageModelToolResultPart` (normalizing array-based content into a single newline-delimited string), and `LanguageModelDataPart`. For `LanguageModelDataPart`, it automatically encodes `image/*` mimetypes as base64 and attempts to decode other data types as UTF-8 text. It ensures the conversation history starts with a user message by inserting a placeholder if necessary.
2. Extracts system instructions from the message history to pass as top-level `system` blocks. Tool definitions are also accounted for in the system-level character consumption metrics.
3. Automatically applies cache control strategies:
    - **Static Prefix Caching**: Applies `ephemeral` caching to the system blocks or tool definitions.
    - **Chat History Caching**: Applies `ephemeral` caching to the second-to-last message in the history if the estimated total history exceeds 1024 tokens.
4. Executes the request using a robust retry mechanism for transient API failures (such as 429 or 503) with a configurable maximum duration to ensure request resilience.
5. Manages streaming responses, reporting text deltas and tool call progress to VS Code after parsing partial JSON tool inputs.
6. Captures and returns detailed usage statistics, including `input`, `output`, `cache_read`, and `cache_create` token metrics. It also reports these statistics back to VS Code via a `LanguageModelDataPart` (MIME type `usage`) containing `prompt_tokens`, `completion_tokens`, `total_tokens`, and `cached_tokens` to update the native Copilot Chat usage indicator.
7. Integrates metadata labels (provided via the `labels` parameter or the provider's internal state) into the API request context for downstream cost tracking and telemetry.

### VertexGoogleProvider
[source](../src/providers/VertexGoogleProvider.ts)
The `VertexGoogleProvider` class implements the `VertexModelProvider` interface for Google Gemini models hosted on Vertex AI. It manages the lifecycle of the `@google/genai` client and handles the complexities of Gemini-specific features like thinking signatures and parallel tool calls.

#### initialize
[source](../src/providers/VertexGoogleProvider.ts)
`initialize(projectId: string, region: string, authOptions?: any): void`

Sets the GCP Project ID and regional endpoint (e.g., `us-central1`) for the provider. It also initiates a dynamic schema discovery process to fetch the latest supported OpenAPI 3.0 schema keys from the Vertex AI Discovery API, ensuring tool definitions remain compatible with API updates. If provided, `authOptions` are stored and passed to the `GoogleGenAI` client during lazy initialization.

#### setLabels
[source](../src/providers/VertexGoogleProvider.ts)
`setLabels(labels: Record<string, string>): void`

Configures the provider with a set of labels to be attached to Vertex AI requests. These are typically used for billing attribution and usage monitoring.

#### pingModel
[source](../src/providers/VertexGoogleProvider.ts)
`pingModel(modelId: string): Promise<boolean>`

Attempts a minimal request to the specified model ID to verify availability and permissions in the current GCP project. It automatically resolves high-thinking model IDs to their base counterparts and handles transient rate-limiting errors gracefully during discovery. Configured labels are included in the request payload.

#### provideTokenCount
[source](../src/providers/VertexGoogleProvider.ts)
`provideTokenCount(text: string | vscode.LanguageModelChatRequestMessage, _token: vscode.CancellationToken): Promise<number>`

Provides a rough estimation of token usage. For text or message objects, it computes the count based on a 4-characters-per-token heuristic.

#### isLeakedReasoningHeader
[source](../src/providers/VertexGoogleProvider.ts)
`isLeakedReasoningHeader(text: string, modelId: string, actualId: string): boolean`

Detects if a given text segment is the starting chunk of a leaked reasoning block (e.g., `gemini-3.5-flash-high\5R+S41tN...`). It checks if the text starts with the configured or resolved model ID followed by a path separator.

#### stripLeakedReasoningHeader
[source](../src/providers/VertexGoogleProvider.ts)
`stripLeakedReasoningHeader(text: string): string`

Strips the leaked signature prefix from a reasoning header text block, returning only the clean answer text that follows the first newline.

#### provideLanguageModelChatResponse
[source](../src/providers/VertexGoogleProvider.ts)
`provideLanguageModelChatResponse(modelId: string, messages: readonly vscode.LanguageModelChatRequestMessage[], options: vscode.ProvideLanguageModelChatResponseOptions, progress: vscode.Progress<vscode.LanguageModelResponsePart>, token: vscode.CancellationToken, labels?: Record<string, string>): Promise<ChatInferenceResult>`

Main entry point for chat inference. This method:
1. Maps VS Code messages to the Gemini `contents` format, including support for multimodal `LanguageModelDataPart` (images and non-image data decoding), and ensures the conversation starts with a user message as required by the Gemini API.
2. **Sanitizes tool input schemas** using a deep-recursive positive filter to ensure compatibility with Vertex AI's OpenAPI 3.0 requirements. It preserves only schema properties that are explicitly supported by the Google Cloud AI Platform (e.g., `type`, `properties`, `required`), stripping out arbitrary or non-standard metadata keys like `$comment` or `enumDescriptions` that would otherwise trigger `400 INVALID_ARGUMENT` responses.
3. Re-injects cached thought signatures into the conversation history for both **assistant text parts** and **tool call parts** to preserve reasoning quality. It also proactively sanitizes leaked reasoning headers from model turns in history.
4. Merges consecutive tool result messages into a single user turn to satisfy Gemini API requirements for parallel tool calls.
5. **Normalizes tool results** into JSON objects, wrapping primitive return values to comply with Gemini's `google.protobuf.Struct` requirement for function responses, and ensuring the function name is correctly associated with the response.
6. Handles streaming responses with **automatic retries**, using a stateful `StreamPartProcessor` to isolate and strip multi-chunk leaked reasoning/thinking blocks while capturing text, tool calls, and `thoughtSignature` metadata.
7. Buffers parallel tool calls across the stream to ensure they are emitted to VS Code as a single atomic step, preventing turn-mismatch errors.
8. Updates internal signature caches for both text reasoning (using a text-prefix key based on the first 120 characters) and tool calls (using unique call IDs).
9. Tracks and returns detailed usage statistics including character counts and token usage metadata (input, output, and cache metrics). For Gemini, it correctly adjusts input tokens by subtracting cached content tokens to ensure accurate usage tracking, and reports the resulting payload to VS Code via `LanguageModelDataPart` (MIME `usage`).
10. Attaches metadata labels (preferring the `labels` argument over instance-level labels) to the generation request, enabling granular cost attribution and usage monitoring in the Google Cloud Console.

### VertexMaaSProvider
[source](../src/providers/VertexMaaSProvider.ts)
The `VertexMaaSProvider` class implements the `VertexModelProvider` interface for third-party models available on Vertex AI via the Models-as-a-Service (MaaS) endpoint. It utilizes an OpenAI-compatible interface to communicate with Vertex AI endpoints for models such as DeepSeek, Qwen, and Kimi.

#### initialize
[source](../src/providers/VertexMaaSProvider.ts)
`initialize(projectId: string, region: string, authOptions?: any): void`

Sets the GCP Project ID and regional endpoint. It configures the provider to use OpenAI SDK pointing to the Google Cloud Vertex MaaS `baseURL`. It supports authentication via standard Application Default Credentials or provided Service Account credentials.

#### setLabels
[source](../src/providers/VertexMaaSProvider.ts)
`setLabels(labels: Record<string, string>): void`

Updates internal labels for request tracking.

#### pingModel
[source](../src/providers/VertexMaaSProvider.ts)
`pingModel(modelVersion: string): Promise<boolean>`

Verifies the availability of the model path (e.g., `deepseek-ai/deepseek-v3.2-maas`) by sending a minimal OpenAI-format chat completion request.

#### provideTokenCount
[source](../src/providers/VertexMaaSProvider.ts)
`provideTokenCount(text: string | vscode.LanguageModelChatRequestMessage, _token: vscode.CancellationToken): Promise<number>`

Estimates token usage using a 4-characters-per-token heuristic.

#### provideLanguageModelChatResponse
[source](../src/providers/VertexMaaSProvider.ts)
`provideLanguageModelChatResponse(modelId: string, messages: readonly vscode.LanguageModelChatRequestMessage[], options: vscode.ProvideLanguageModelChatResponseOptions, progress: vscode.Progress<vscode.LanguageModelResponsePart>, token: vscode.CancellationToken, labels?: Record<string, string>): Promise<ChatInferenceResult>`

Handles chat inference for MaaS models using an OpenAI client. This method:
1. Maps VS Code messages to OpenAI chat completion parameters. It supports `LanguageModelTextPart`, `LanguageModelToolCallPart`, `LanguageModelToolResultPart` (transformed into discrete `tool` role messages), and `LanguageModelDataPart` (including base64 image conversion or UTF-8 decoding for other data types).
2. Looks up model-specific execution parameters (such as `temperature`, `top_p`, and `maxOutputTokens`) from the local model catalog and applies configuration for enabling `reasoning_content` for thinking models like DeepSeek and Kimi.
3. Implements specialized logic for DeepSeek models: the system prompt is omitted when tools are enabled to prevent API validation errors, per GCP MaaS guidance.
4. Ensures conversation history integrity by prepending a placeholder user message if the history starts with a system or assistant turn.
5. Executes requests using a retry mechanism to handle transient failures.
6. Manages streaming via `openai/streaming`, extracting thinking tokens from `reasoning_content` and accumulating incremental tool call deltas until the `finish_reason` is received.
7. Reports token usage back to VS Code via `LanguageModelDataPart` (MIME type `usage`), capturing prompt, completion, and cached token counts from the OpenAI usage payload to update the Copilot Chat indicator.

## Examples