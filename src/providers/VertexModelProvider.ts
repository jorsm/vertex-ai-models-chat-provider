import * as vscode from "vscode";

export interface ModelUsageTokens {
  input: number;
  output: number;
  cache_read: number;
  cache_create: number;
}

export interface CharacterCounts {
  system: number;
  user_text: number;
  assistant_text: number;
  image: number;
  tool_use: number;
  tool_result: number;
}

export interface ChatInferenceResult {
  usage: ModelUsageTokens;
  charCount: CharacterCounts;
}

export interface VertexModelProvider {
  /** The vendor identifier used in models.json (e.g., 'anthropic', 'gemini') */
  vendor: string;

  /** Configure the provider with project and region */
  initialize(projectId: string, region: string): void;

  /** Update labels to be sent with every request */
  setLabels(labels: Record<string, string>): void;

  /** Send a minimal ping to verify model availability */
  pingModel(modelId: string): Promise<boolean>;

  /**
   * Execute a chat request, map inputs/outputs, and report parts to VS Code.
   */
  provideLanguageModelChatResponse(
    modelId: string,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
    labels?: Record<string, string>
  ): Promise<ChatInferenceResult>;

  /**
   * Optional token counting heuristic, defaults to char-count based in dispatcher if not provided
   */
  provideTokenCount?(
    text: string | vscode.LanguageModelChatRequestMessage,
    token: vscode.CancellationToken
  ): Promise<number>;
}
