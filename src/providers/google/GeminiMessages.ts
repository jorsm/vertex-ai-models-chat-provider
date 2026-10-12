import * as vscode from "vscode";
import type { Logger } from "../../utils/Logger";
import type { CharacterCounts } from "../VertexModelProvider";

/** Header operations shared by conversation mapping and stream text filtering. */
export interface GeminiReasoningHeaders {
    isLeakedReasoningHeader(text: string, modelId: string, actualId: string): boolean;
    stripLeakedReasoningHeader(text: string): string;
}

/**
 * Maps VS Code history into Gemini contents using the provider's signature caches.
 *
 * @remarks
 * Cache maps are borrowed by reference. Mapping records tool names in history order,
 * groups adjacent user tool-result turns, and inserts a leading user placeholder when
 * required. Character counters retain their existing provider-specific units.
 */
export class GeminiMessages {
    constructor(
        private readonly thoughtSignatureCache: Map<string, string>,
        private readonly textSignatureCache: Map<string, string>,
        private readonly reasoningHeaders: GeminiReasoningHeaders,
        private readonly logger: Logger,
    ) {}

    /**
     * Separates system text and maps the remaining history into Gemini content turns.
     * Adjacent user tool-result turns are merged and a leading user placeholder is
     * inserted when the mapped history is empty or starts with a model turn.
     *
     * @param messages - The standard readonly VS Code message list representing the active chat history.
     * @param charCount - The running character count analytics object.
     * @param modelId - The configured/requested VS Code model ID.
     * @param actualId - The actual resolved Vertex AI model/endpoint ID.
     * @returns An object containing mapped content structures and the isolated system instruction.
     */
    extractMessages(messages: readonly vscode.LanguageModelChatRequestMessage[], charCount: CharacterCounts, modelId: string, actualId: string): { mappedContents: any[]; systemInstruction: string } {
        const mappedContents: any[] = [];
        let systemInstruction = "";
        const callIdToName = new Map<string, string>();

        for (const msg of messages) {
            const roleName = this.mapRole(msg.role);

            if (roleName === "system") {
                for (const p of msg.content) {
                    if (p instanceof vscode.LanguageModelTextPart) {
                        systemInstruction += p.value + "\n";
                        charCount.system += p.value.length;
                    }
                }
                continue;
            }

            const parts = this.mapMessageParts(msg, roleName, modelId, actualId, charCount, callIdToName);

            if (parts.length > 0) {
                mappedContents.push({ role: roleName, parts });
            } else {
                mappedContents.push({ role: roleName, parts: [{ text: " " }] });
            }
        }

        const merged = this.mergeParallelToolResponses(mappedContents);

        if (merged.length === 0 || merged[0].role !== "user") {
            merged.unshift({ role: "user", parts: [{ text: " " }] });
        }

        return { mappedContents: merged, systemInstruction };
    }

    /** Treats roles other than user and assistant as system instructions. */
    private mapRole(roleNum: number): string {
        if (roleNum === vscode.LanguageModelChatMessageRole.User) {
            return "user";
        }
        if (roleNum === vscode.LanguageModelChatMessageRole.Assistant) {
            return "model";
        }
        return "system";
    }

    /**
     * Produces a function response with an object payload and its resolved function name.
     * Non-object JSON and non-JSON results remain strings inside a `result` wrapper.
     */
    private mapToolResult(p: vscode.LanguageModelToolResultPart, callName?: string): any {
        let resStr = "{}";
        if (Array.isArray(p.content)) {
            resStr = p.content
                .map((c) => {
                    if (c instanceof vscode.LanguageModelTextPart) {
                        return c.value;
                    }
                    return JSON.stringify(c);
                })
                .join("\n");
        } else {
            resStr = String(p.content);
        }

        // Use the function name for the response name field (Gemini requires the
        // actual function name, not a unique call ID). Fall back to callId if name
        // is not available (e.g. non-thinking models where callId === name).
        const responseName = callName ?? p.callId;
        try {
            const parsed = JSON.parse(resStr);
            // Gemini expects 'response' to be a google.protobuf.Struct, which is a JSON object (map).
            // If the parsed JSON is not a plain object (e.g. it's a string, number, or array),
            // we must wrap it in an object to satisfy the Struct requirement.
            if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
                return { functionResponse: { name: responseName, response: parsed } };
            }
        } catch {
            // ignore
        }
        return { functionResponse: { name: responseName, response: { result: resStr } } };
    }

    /**
     * Maps a single VS Code `LanguageModelChatRequestMessage` to its respective raw parts array
     * for the Google Gen AI / Vertex AI API, filtering leaked reasoning headers
     * and reattaching signatures from the provider's existing caches.
     *
     * @param msg - The source VS Code message to map.
     * @param roleName - The role of the message sender ("user", "model", "system").
     * @param modelId - The configured/requested VS Code model ID.
     * @param actualId - The actual resolved Vertex AI model/endpoint ID.
     * @param charCount - The running character count analytics object.
     * @param callIdToName - A map tracking tool call IDs to their original function names.
     * @returns An array of mapped content parts conformant to Vertex AI schema requirements.
     */
    private mapMessageParts(msg: vscode.LanguageModelChatRequestMessage, roleName: string, modelId: string, actualId: string, charCount: CharacterCounts, callIdToName: Map<string, string>): any[] {
        const parts: any[] = [];
        for (const p of msg.content) {
            if (p instanceof vscode.LanguageModelTextPart) {
                if (p.value.length > 0) {
                    let cleanText = p.value;
                    if (roleName === "model" && this.reasoningHeaders.isLeakedReasoningHeader(cleanText, modelId, actualId)) {
                        const stripped = this.reasoningHeaders.stripLeakedReasoningHeader(cleanText);
                        if (stripped.length > 0) {
                            cleanText = stripped;
                            this.logger.log(`  🧹 Stripped leaked reasoning header from model turn in history`);
                        } else {
                            cleanText = "";
                            this.logger.log(`  🧹 Stripped entire leaked reasoning model turn in history`);
                        }
                    }

                    if (roleName === "model") {
                        const textKey = cleanText.substring(0, 120);
                        const cachedTextSig = this.textSignatureCache.get(textKey);
                        if (cachedTextSig) {
                            parts.push({ text: cleanText, thoughtSignature: cachedTextSig });
                            this.logger.log(`  📋 Text part in history: re-attached thought signature (${cachedTextSig.length} chars)`);
                        } else {
                            parts.push({ text: cleanText });
                        }
                    } else {
                        parts.push({ text: cleanText });
                    }

                    if (roleName === "user") {
                        charCount.user_text += cleanText.length;
                    } else {
                        charCount.assistant_text += cleanText.length;
                    }
                }
            } else if (p instanceof vscode.LanguageModelToolCallPart) {
                callIdToName.set(p.callId, p.name);
                const cachedSig = this.thoughtSignatureCache.get(p.callId);
                this.logger.log(`  📋 ToolCall in history: callId=${p.callId} name=${p.name} hasCachedSig=${!!cachedSig} cacheSize=${this.thoughtSignatureCache.size}`);
                if (cachedSig) {
                    parts.push({ functionCall: { name: p.name, args: p.input }, thoughtSignature: cachedSig });
                    this.logger.log(`    ↪ injected inline thought signature on functionCall part (${cachedSig.length} chars)`);
                } else {
                    this.logger.log(`    ⚠️  NO thought signature found for callId=${p.callId}`);
                    parts.push({ functionCall: { name: p.name, args: p.input } });
                }
                charCount.tool_use += JSON.stringify(p.input).length + p.name.length;
            } else if (p instanceof vscode.LanguageModelToolResultPart) {
                const resolvedName = callIdToName.get(p.callId);
                this.logger.log(`  📋 ToolResult in history: callId=${p.callId} resolvedName=${resolvedName ?? "(not found, using callId)"}`);
                parts.push(this.mapToolResult(p, resolvedName));
                charCount.tool_result += 1;
            } else if (p instanceof vscode.LanguageModelDataPart) {
                if (p.mimeType?.startsWith("image/")) {
                    parts.push({
                        inlineData: { mimeType: p.mimeType, data: Buffer.from(p.data).toString("base64") },
                    });
                    charCount.image += p.data.byteLength;
                } else {
                    try {
                        const text = new TextDecoder().decode(p.data);
                        if (text.length > 0) {
                            parts.push({ text });
                        }
                    } catch (e) {
                        this.logger.log(`⚠️  Unparseable data part: ${e}`);
                    }
                }
            }
        }
        return parts;
    }

    /**
     * Merges adjacent user turns whose parts are all function responses.
     * The preceding mapped turn is extended in place; other turns retain their order.
     *
     * @param mappedContents - The list of mapped roles and parts.
     * @returns A merged list of messages with parallel tool calls consolidated.
     */
    private mergeParallelToolResponses(mappedContents: any[]): any[] {
        const merged: any[] = [];
        for (const content of mappedContents) {
            const prev = merged.at(-1);
            const isFunctionResponseOnly = (c: any) => c.role === "user" && c.parts.every((p: any) => p.functionResponse !== undefined);
            if (prev && isFunctionResponseOnly(prev) && isFunctionResponseOnly(content)) {
                prev.parts.push(...content.parts);
            } else {
                merged.push(content);
            }
        }
        return merged;
    }
}

/**
 * Detects if the given text segment is the starting chunk of a leaked reasoning block
 * (e.g. `gemini-3.5-flash\5R+S41tN...`).
 *
 * @param text - The text chunk/part to inspect.
 * @param modelId - The configured/requested VS Code model ID.
 * @param actualId - The actual resolved Vertex AI model/endpoint ID.
 * @returns `true` if the text starts with the leaked reasoning signature prefix; otherwise `false`.
 */
export function isLeakedReasoningHeader(text: string, modelId: string, actualId: string): boolean {
    const trimmed = text.trimStart();
    return trimmed.startsWith(modelId + "\\") || trimmed.startsWith(actualId + "\\") || trimmed.startsWith(modelId + "/") || trimmed.startsWith(actualId + "/");
}

/**
 * Strips the leaked signature prefix from a reasoning header text block, returning only
 * the clean answer text following the first newline.
 *
 * @param text - The dirty text containing the leaked reasoning header prefix.
 * @returns The remaining text after the prefix block (i.e. everything after the first newline),
 *          or an empty string if there is no newline (meaning the block is purely signature metadata).
 */
export function stripLeakedReasoningHeader(text: string): string {
    const firstNewline = text.indexOf("\n");
    if (firstNewline !== -1) {
        return text.substring(firstNewline + 1);
    }
    return "";
}
