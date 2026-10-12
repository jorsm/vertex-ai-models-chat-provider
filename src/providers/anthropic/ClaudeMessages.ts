import * as vscode from "vscode";

import type { Logger } from "../../utils/Logger";

import type { CharacterCounts } from "../VertexModelProvider";

type ClaudeRequestPart = vscode.LanguageModelChatRequestMessage["content"][number];

/**
 * Converts VS Code history into Claude system blocks and user/assistant messages.
 *
 * @remarks
 * Non-user/assistant roles contribute only text to the system prompt. Empty
 * content and histories that do not start with a user receive a single-space
 * placeholder. Mutates the supplied character counters and logs message parts.
 *
 * @returns System blocks, when present, and messages in their original order.
 */
export function mapClaudeMessages(messages: readonly vscode.LanguageModelChatRequestMessage[], charCount: CharacterCounts, logger: Logger): { systemBlocks: any[] | undefined; mappedMessages: any[] } {
    const systemParts: string[] = [];
    const mappedMessages: any[] = [];
    for (const [
        i,
        msg,
    ] of messages.entries()) {
        const roleNum = msg.role;
        const roleName = describeRole(roleNum);
        logger.log(`  ── Message [${i}] role=${roleName} (${roleNum}), ${msg.content.length} part(s)`);
        logMessageParts(msg.content, logger);
        if (roleNum !== vscode.LanguageModelChatMessageRole.User && roleNum !== vscode.LanguageModelChatMessageRole.Assistant) {
            extractSystemParts(msg.content, systemParts, charCount, logger);
            continue;
        }
        const role = roleNum === vscode.LanguageModelChatMessageRole.User ? "user" : "assistant";
        const contentParts = mapContentParts(msg.content, role, charCount, logger);
        mappedMessages.push({ role, content: contentParts });
    }
    if (mappedMessages.length === 0 || mappedMessages[0].role !== "user") {
        logger.log(`  ⚠️  No user messages — inserting placeholder`);
        mappedMessages.unshift({ role: "user", content: [{ type: "text", text: " " }] });
    }
    const systemBlocks = systemParts.length > 0 ? systemParts.map((text) => ({ type: "text", text })) : undefined;
    return { systemBlocks, mappedMessages };
}

/**
 * Maps tool declarations and adds their serialized size to system attribution.
 *
 * @returns Undefined when no tools are supplied. Missing schemas use an empty
 * object schema; supplied schemas are passed through unchanged.
 */
export function mapClaudeTools(options: vscode.ProvideLanguageModelChatResponseOptions, charCount: { system: number }): any[] | undefined {
    if (!options.tools?.length) {
        return undefined;
    }
    const tools = options.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema ?? { type: "object", properties: {} },
    }));
    charCount.system += JSON.stringify(tools).length;
    return tools;
}

/**
 * Logs mapped block types, cache markers and request dimensions.
 */
export function logClaudeMessages(modelId: string, mappedMessages: any[], systemBlocks: any[] | undefined, tools: any[] | undefined, maxTokens: number, logger: Logger): void {
    logger.log(`  ── Mapped messages summary ──`);
    for (let i = 0; i < mappedMessages.length; i++) {
        const mm = mappedMessages[i];
        const partsDesc = mm.content.map((p: any) => p.type + (p.cache_control ? " [CACHED]" : "")).join(", ");
        logger.log(`     [${i}] ${mm.role}: ${partsDesc}`);
    }
    const sysCharCount = systemBlocks ? systemBlocks.reduce((a: number, b: any) => a + b.text.length, 0) : 0;
    const sysLog = systemBlocks ? sysCharCount + " chars" : "none";
    logger.log(`  Sending: model=${modelId}, max_tokens=${maxTokens}, msgs=${mappedMessages.length}, system=${sysLog}, tools=${tools?.length ?? 0}`);
}

/**
 * Names request roles for diagnostics; every other role is reported as system.
 */
function describeRole(roleNum: vscode.LanguageModelChatMessageRole): string {
    if (roleNum === vscode.LanguageModelChatMessageRole.User) {
        return "User";
    }
    if (roleNum === vscode.LanguageModelChatMessageRole.Assistant) {
        return "Assistant";
    }
    return "System";
}

/**
 * Appends nonempty text parts to the system prompt and counts their characters.
 */
function extractSystemParts(content: readonly ClaudeRequestPart[], systemParts: string[], charCount: { system: number }, logger: Logger): void {
    for (const part of content) {
        if (part instanceof vscode.LanguageModelTextPart && part.value.length > 0) {
            systemParts.push(part.value);
            charCount.system += part.value.length;
        }
    }
    logger.log(`     → Extracted as system prompt (${systemParts.length} part(s) so far, ${systemParts.reduce((a, s) => a + s.length, 0)} chars total)`);
}

/**
 * Logs the existing text/tool previews and data-part metadata for one message.
 *
 * @remarks These diagnostics retain payload previews; see the deferred logging
 * discussion in `docs/providers-follow-up.md`.
 */
function logMessageParts(content: readonly ClaudeRequestPart[], logger: Logger): void {
    content.forEach((part, p) => {
        if (part instanceof vscode.LanguageModelTextPart) {
            const preview = part.value.length > 300 ? "…" + part.value.slice(-300) : part.value;
            logger.log(`     Part [${p}] TextPart (${part.value.length} chars): ${preview}`);
        } else if (part instanceof vscode.LanguageModelToolResultPart) {
            logger.log(`     Part [${p}] ToolResultPart callId=${part.callId}, content: ${previewToolResult(part)}`);
        } else if (part instanceof vscode.LanguageModelToolCallPart) {
            const inputStr = JSON.stringify(part.input);
            const inputPreview = inputStr.length > 200 ? "…" + inputStr.slice(-200) : inputStr;
            logger.log(`     Part [${p}] ToolCallPart callId=${part.callId}, name=${part.name}, input=${inputPreview}`);
        } else if (part instanceof vscode.LanguageModelDataPart) {
            logger.log(`     Part [${p}] DataPart mime=${part.mimeType}, size=${part.data?.byteLength ?? 0} bytes`);
        } else {
            const keys = Object.keys(part as object);
            const snapshot = keys
                .slice(0, 5)
                .map((k) => `${k}=${String((part as Record<string, unknown>)[k]).slice(0, 50)}`)
                .join(", ");
            logger.log(`     Part [${p}] Unknown part type: ${Object.getPrototypeOf(part)?.constructor?.name ?? typeof part} — keys: [${keys.join(", ")}] ${snapshot}`);
        }
    });
}

/**
 * Builds the existing diagnostic preview for array and legacy result content.
 */
function previewToolResult(part: vscode.LanguageModelToolResultPart): string {
    if (!Array.isArray(part.content)) {
        const s = String(part.content);
        return s.length > 100 ? "…" + s.slice(-100) : s;
    }
    return part.content
        .map((c) => {
            if (c instanceof vscode.LanguageModelTextPart) {
                return c.value.length > 100 ? "…" + c.value.slice(-100) : c.value;
            }
            return JSON.stringify(c).slice(-100);
        })
        .join(", ");
}

/**
 * Preserves recognized content order and supplies a placeholder when none remain.
 */
function mapContentParts(content: readonly ClaudeRequestPart[], role: string, charCount: { user_text: number; assistant_text: number; image: number; tool_use: number; tool_result: number }, logger: Logger): any[] {
    const contentParts: any[] = [];
    for (const part of content) {
        if (part instanceof vscode.LanguageModelTextPart) {
            mapTextPart(part, role, contentParts, charCount);
        } else if (part instanceof vscode.LanguageModelToolResultPart) {
            mapToolResultPart(part, contentParts, charCount);
        } else if (part instanceof vscode.LanguageModelToolCallPart) {
            contentParts.push({ type: "tool_use", id: part.callId, name: part.name, input: part.input });
            charCount.tool_use += JSON.stringify(part.input).length + part.name.length;
        } else if (part instanceof vscode.LanguageModelDataPart) {
            mapDataPart(part, role, contentParts, charCount, logger);
        }
    }
    if (contentParts.length === 0) {
        contentParts.push({ type: "text", text: " " });
    }
    return contentParts;
}

/**
 * Appends nonempty text and attributes its length to the corresponding role.
 */
function mapTextPart(part: vscode.LanguageModelTextPart, role: string, contentParts: any[], charCount: { user_text: number; assistant_text: number }): void {
    if (part.value.length === 0) {
        return;
    }
    contentParts.push({ type: "text", text: part.value });
    if (role === "user") {
        charCount.user_text += part.value.length;
    } else {
        charCount.assistant_text += part.value.length;
    }
}

/**
 * Serializes array result content; other content currently maps to a placeholder.
 */
function mapToolResultPart(part: vscode.LanguageModelToolResultPart, contentParts: any[], charCount: { tool_result: number }): void {
    let toolResultStr = "";
    if (Array.isArray(part.content)) {
        toolResultStr = part.content.map((c) => (c instanceof vscode.LanguageModelTextPart ? c.value : JSON.stringify(c))).join("\n");
    }
    contentParts.push({ type: "tool_result", tool_use_id: part.callId, content: toolResultStr || " " });
    charCount.tool_result += toolResultStr.length;
}

/**
 * Encodes images as base64 and decodes other data as text.
 *
 * @remarks Image attribution counts base64 characters, rather than source bytes.
 */
function mapDataPart(part: vscode.LanguageModelDataPart, role: string, contentParts: any[], charCount: { user_text: number; assistant_text: number; image: number }, logger: Logger): void {
    if (part.mimeType?.startsWith("image/")) {
        const base64 = Buffer.from(part.data).toString("base64");
        contentParts.push({ type: "image", source: { type: "base64", media_type: part.mimeType, data: base64 } });
        charCount.image += base64.length;
        logger.log(`     🖼️  Mapped image: ${part.mimeType}, ${part.data.byteLength} bytes → base64 (${base64.length} chars)`);
    } else {
        mapNonImageDataPart(part, role, contentParts, charCount, logger);
    }
}

/**
 * Decodes non-image data as text, skipping empty or undecodable content.
 */
function mapNonImageDataPart(part: vscode.LanguageModelDataPart, role: string, contentParts: any[], charCount: { user_text: number; assistant_text: number }, logger: Logger): void {
    try {
        const text = new TextDecoder().decode(part.data);
        if (text.length > 0) {
            contentParts.push({ type: "text", text });
            if (role === "user") {
                charCount.user_text += text.length;
            } else {
                charCount.assistant_text += text.length;
            }
            logger.log(`     📎 Mapped non-image DataPart (${part.mimeType}) as text (${text.length} chars)`);
        }
    } catch {
        logger.log(`     ⚠️  Skipped non-image DataPart (${part.mimeType}, ${part.data.byteLength} bytes) — could not decode`);
    }
}
