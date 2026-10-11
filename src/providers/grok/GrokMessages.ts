import type OpenAI from "openai";
import * as vscode from "vscode";
import type { CharacterCounts } from "../VertexModelProvider";
import type { Logger } from "../../utils/Logger";

/**
 * Maps chat history to OpenAI-compatible messages and updates character counters.
 *
 * Unknown roles contribute text to a leading system message. Tool results become
 * separate messages after their originating chat message, and a blank user turn
 * is inserted when the first conversation message is not a user message. Images
 * count their base64 characters; cache-control data parts are ignored.
 */
export function mapGrokMessages(messages: readonly vscode.LanguageModelChatRequestMessage[], charCount: CharacterCounts, logger: Logger): any[] {
    const systemParts: string[] = [];
    const mappedMessages: any[] = [];

    for (const msg of messages) {
        const roleNum = msg.role;

        if (roleNum === (0 as vscode.LanguageModelChatMessageRole)) {
            extractSystemParts(msg.content, systemParts, charCount);
            continue;
        }

        if (roleNum !== vscode.LanguageModelChatMessageRole.User && roleNum !== vscode.LanguageModelChatMessageRole.Assistant) {
            // Unknown role — treat as system
            extractSystemParts(msg.content, systemParts, charCount);
            continue;
        }

        for (const entry of mapConversationMessage(msg, charCount, logger)) {
            mappedMessages.push(entry);
        }
    }

    if (systemParts.length > 0) {
        mappedMessages.unshift({ role: "system", content: systemParts.join("\n") });
    }

    // A leading system prompt is valid; only insert a user turn if one is missing.
    const firstConversationIndex = mappedMessages.findIndex((message) => message.role !== "system");
    if (firstConversationIndex === -1 || mappedMessages[firstConversationIndex].role !== "user") {
        logger.log(`  ⚠️  No user messages — inserting placeholder`);
        mappedMessages.splice(firstConversationIndex === -1 ? mappedMessages.length : firstConversationIndex, 0, { role: "user", content: [{ type: "text", text: " " }] });
    }

    return mappedMessages;
}

/** Maps tool declarations, preserving supplied schemas and defaulting absent ones. */
export function mapGrokTools(options: vscode.ProvideLanguageModelChatResponseOptions): any[] | undefined {
    if (!options.tools?.length) {
        return undefined;
    }

    return options.tools.map((t) => ({
        type: "function" as const,
        function: {
            name: t.name,
            description: t.description,
            parameters: t.inputSchema ?? { type: "object", properties: {} },
        },
    }));
}

/** Maps one user or assistant message, followed by its separate tool results. */
function mapConversationMessage(msg: vscode.LanguageModelChatRequestMessage, charCount: CharacterCounts, logger: Logger): any[] {
    const mappedMessages: any[] = [];
    const role = msg.role === vscode.LanguageModelChatMessageRole.User ? "user" : "assistant";
    const isAssistant = role === "assistant";

    // For assistant messages, we handle tool calls and tool results separately
    const textParts: (string | OpenAI.Chat.Completions.ChatCompletionContentPartImage)[] = [];
    const toolCalls: any[] = [];
    const toolResultMessages: any[] = [];

    for (const part of msg.content) {
        if (part instanceof vscode.LanguageModelTextPart) {
            const text = part.value;
            if (isAssistant) {
                textParts.push(text);
                charCount.assistant_text += text.length;
            } else {
                textParts.push(text);
                charCount.user_text += text.length;
            }
        } else if (part instanceof vscode.LanguageModelToolCallPart) {
            toolCalls.push({
                id: part.callId,
                type: "function",
                function: {
                    name: part.name,
                    arguments: JSON.stringify(part.input),
                },
            });
            charCount.tool_use += JSON.stringify(part.input).length + part.name.length;
        } else if (part instanceof vscode.LanguageModelToolResultPart) {
            // Tool results become separate "tool" messages in OpenAI format
            let toolContent = "";
            if (Array.isArray(part.content)) {
                toolContent = part.content.map((c) => (c instanceof vscode.LanguageModelTextPart ? c.value : JSON.stringify(c))).join("\n");
            } else if (part.content !== undefined && part.content !== null) {
                toolContent = String(part.content);
            }
            toolResultMessages.push({
                role: "tool",
                tool_call_id: part.callId,
                content: toolContent || " ",
            });
            charCount.tool_result += toolContent.length;
        } else if (part instanceof vscode.LanguageModelDataPart) {
            // Silently ignore Anthropic-specific cache_control parts
            if (part.mimeType === "cache_control") {
                continue;
            }
            if (part.mimeType?.startsWith("image/")) {
                const base64 = Buffer.from(part.data).toString("base64");
                textParts.push({ type: "image_url", image_url: { url: `data:${part.mimeType};base64,${base64}` } });
                charCount.image += base64.length;
            } else {
                try {
                    const text = new TextDecoder().decode(part.data);
                    if (text.length > 0) {
                        textParts.push(text);
                        if (isAssistant) {
                            charCount.assistant_text += text.length;
                        } else {
                            charCount.user_text += text.length;
                        }
                        logger.log(`     📎 Mapped non-image DataPart (${part.mimeType}) as text (${text.length} chars)`);
                    }
                } catch {
                    logger.log(`     ⚠️  Skipped non-image DataPart (${part.mimeType}) — could not decode`);
                }
            }
        }
    }

    // Build the OpenAI-format message
    const hasText = textParts.length > 0;
    const hasToolCalls = toolCalls.length > 0;

    if (hasText || hasToolCalls) {
        const entry: any = { role };
        // Check if any textPart is an object (image_url) — images need array format
        const hasImageParts = textParts.some((t) => typeof t !== "string");
        if (hasText) {
            entry.content = hasImageParts || !isAssistant ? textParts.map((t) => (typeof t === "string" ? { type: "text", text: t } : t)) : textParts.join("\n");
        }
        if (hasToolCalls) {
            entry.tool_calls = toolCalls;
        }
        mappedMessages.push(entry);
    }

    // Append tool result messages after the assistant message
    for (const tr of toolResultMessages) {
        mappedMessages.push(tr);
    }
    return mappedMessages;
}

/** Collects nonempty text only from system or otherwise unrecognized roles. */
function extractSystemParts(content: readonly vscode.LanguageModelChatRequestMessage["content"][number][], systemParts: string[], charCount: { system: number }): void {
    for (const part of content) {
        if (part instanceof vscode.LanguageModelTextPart && part.value.length > 0) {
            systemParts.push(part.value);
            charCount.system += part.value.length;
        }
    }
}
