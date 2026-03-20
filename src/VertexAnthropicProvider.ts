import * as vscode from 'vscode';
import { AnthropicVertex } from '@anthropic-ai/vertex-sdk';

export class VertexAnthropicProvider implements vscode.LanguageModelChatProvider {
    private client: AnthropicVertex;

    constructor(projectId: string, region: string) {
        this.client = new AnthropicVertex({
            projectId: projectId,
            region: region,
        });
    }

    provideLanguageModelChatInformation(
        options: vscode.PrepareLanguageModelChatModelOptions,
        token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.LanguageModelChatInformation[]> {
        return [{
            id: 'vertex-anthropic',
            name: 'Vertex Claude 4.6 Opus',
            family: 'claude',
            version: 'claude-4-6-opus',
            maxInputTokens: 200000,
            maxOutputTokens: 4096,
            capabilities: {
                imageInput: false,
                toolCalling: true
            }
        }];
    }

    async provideTokenCount(
        model: vscode.LanguageModelChatInformation,
        text: string | vscode.LanguageModelChatRequestMessage,
        token: vscode.CancellationToken
    ): Promise<number> {
        if (typeof text === 'string') {
            return Math.ceil(text.length / 4);
        } else {
            let totalLength = 0;
            for (const part of text.content) {
                if (part instanceof vscode.LanguageModelTextPart) {
                    totalLength += part.value.length;
                }
            }
            return Math.ceil(totalLength / 4);
        }
    }

    async provideLanguageModelChatResponse(
        model: vscode.LanguageModelChatInformation,
        messages: readonly vscode.LanguageModelChatRequestMessage[],
        options: vscode.ProvideLanguageModelChatResponseOptions,
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        token: vscode.CancellationToken
    ): Promise<void> {

        const mappedMessages: any[] = [];
        for (const msg of messages) {
            if (msg.role !== vscode.LanguageModelChatMessageRole.User && msg.role !== vscode.LanguageModelChatMessageRole.Assistant) {
                continue;
            }
            const role = msg.role === vscode.LanguageModelChatMessageRole.User ? 'user' : 'assistant';
            const contentParts: any[] = [];

            for (const part of msg.content) {
                if (part instanceof vscode.LanguageModelTextPart) {
                    if (part.value.length > 0) {
                        contentParts.push({ type: 'text', text: part.value });
                    }
                } else if (part instanceof vscode.LanguageModelToolResultPart) {
                    let toolResultStr = '';
                    if (Array.isArray(part.content)) {
                        toolResultStr = part.content.map(c => {
                            if (c instanceof vscode.LanguageModelTextPart) {return c.value;}
                            return JSON.stringify(c);
                        }).join('\n');
                    }
                    contentParts.push({
                        type: 'tool_result',
                        tool_use_id: part.callId,
                        content: toolResultStr || ' ',
                    });
                } else if (part instanceof vscode.LanguageModelToolCallPart) {
                    contentParts.push({
                        type: 'tool_use',
                        id: part.callId,
                        name: part.name,
                        input: part.input
                    });
                }
            }
            
            // Anthropic rejects empty messages; ensure at least a single space if all parts were empty
            if (contentParts.length === 0) {
                contentParts.push({ type: 'text', text: ' ' });
            }
            mappedMessages.push({ role, content: contentParts });
        }

        const tools: any[] | undefined = options.tools?.map(t => ({
            name: t.name,
            description: t.description,
            input_schema: t.inputSchema || { type: 'object', properties: {} }
        }));

        const stream = await this.client.messages.create({
            model: 'claude-opus-4-6',
            messages: mappedMessages,
            max_tokens: 4096,
            stream: true,
            tools: tools?.length ? tools : undefined,
        });

        // Tool buffering state
        let activeToolCallId = '';
        let activeToolName = '';
        let activeToolJson = '';

        for await (const chunk of stream) {
            if (token.isCancellationRequested) {
                break;
            }

            if (chunk.type === 'content_block_delta' && chunk.delta.type === 'text_delta') {
                progress.report(new vscode.LanguageModelTextPart(chunk.delta.text));
            } else if (chunk.type === 'content_block_start' && chunk.content_block.type === 'tool_use') {
                activeToolCallId = chunk.content_block.id;
                activeToolName = chunk.content_block.name;
                activeToolJson = '';
            } else if (chunk.type === 'content_block_delta' && chunk.delta.type === 'input_json_delta') {
                activeToolJson += chunk.delta.partial_json;
            } else if (chunk.type === 'content_block_stop' && activeToolCallId) {
                let parsedInput = {};
                try {
                    parsedInput = JSON.parse(activeToolJson);
                } catch(e) {
                    // Ignore JSON parse errors for incomplete/broken inputs
                }

                progress.report(new vscode.LanguageModelToolCallPart(activeToolCallId, activeToolName, parsedInput));
                activeToolCallId = '';
                activeToolName = '';
                activeToolJson = '';
            }
        }
    }
}
