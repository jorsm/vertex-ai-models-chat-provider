import * as vscode from "vscode";

/**
 * Robust token estimation utility that handles all standard VS Code message content parts
 * including Text, ToolCall, ToolResult, and Data parts with defensive runtime checks
 * for backward compatibility with VS Code <= 1.119.
 *
 * Heuristic: ~4 characters per token as a baseline.
 */
export function estimateTokens(text: string | vscode.LanguageModelChatRequestMessage): number {
  if (typeof text === "string") {
    return Math.ceil(text.length / 4);
  }

  let length = 0;
  if (text && text.content && Array.isArray(text.content)) {
    for (const part of text.content) {
      if (part instanceof vscode.LanguageModelTextPart) {
        length += part.value.length;
      } else if (part instanceof vscode.LanguageModelToolCallPart) {
        length += part.name.length;
        if (part.input) {
          try {
            length += JSON.stringify(part.input).length;
          } catch {
            // ignore JSON serialization failures
          }
        }
      } else if (part instanceof vscode.LanguageModelToolResultPart) {
        if (Array.isArray(part.content)) {
          for (const c of part.content) {
            if (c instanceof vscode.LanguageModelTextPart) {
              length += c.value.length;
            } else if (typeof c === "string") {
              length += c.length;
            } else if (c !== null && typeof c === "object") {
              try {
                length += JSON.stringify(c).length;
              } catch {
                // ignore
              }
            }
          }
        } else if (part.content !== undefined && part.content !== null) {
          length += String(part.content).length;
        }
      } else if (typeof vscode.LanguageModelDataPart !== "undefined" && part instanceof vscode.LanguageModelDataPart) {
        if (part.data) {
          length += part.data.byteLength;
        }
      }
    }
  }

  return Math.ceil(length / 4);
}
