import * as vscode from "vscode";
import { ChatInferenceResult, VertexModelProvider } from "./VertexModelProvider";

const outputChannel = vscode.window.createOutputChannel("Vertex Google Provider");

function log(msg: string): void {
  const ts = new Date().toISOString();
  outputChannel.appendLine(`[${ts}] ${msg}`);
}

export class VertexGoogleProvider implements VertexModelProvider {
  vendor = "google";
  private client: any;
  private projectId!: string;
  private region!: string;
  /**
   * Cache of thought signatures keyed by tool call ID.
   * When a thinking model returns thought parts before function calls, the
   * thought signatures must be echoed back in subsequent turns. VS Code doesn't
   * preserve these, so we cache them here and re-inject them when we see the
   * corresponding tool call replayed as history.
   */
  private readonly thoughtSignatureCache = new Map<string, string>();

  initialize(projectId: string, region: string): void {
    this.projectId = projectId;
    this.region = region;
  }

  private async getClient() {
    if (!this.client) {
      // Use dynamic import to support ESM-only @google/genai in a CommonJS context
      const genai = await import("@google/genai");

      this.client = new genai.GoogleGenAI({
        // @ts-ignore - type definition restricts vertexai to boolean, but project/location are top-level
        vertexai: true,
        project: this.projectId,
        location: this.region,
      });
    }
    return this.client;
  }

  /**
   * Evaluates the VS Code model ID and returns the actual Endpoint name and thinking parameters
   */
  private resolveModelId(modelId: string): { actualId: string; config?: any } {
    if (modelId.endsWith("-high")) {
      return { actualId: modelId.replace("-high", ""), config: { thinkingConfig: { thinkingLevel: "HIGH" } } };
    }
    return { actualId: modelId };
  }

  async pingModel(modelId: string): Promise<boolean> {
    const { actualId } = this.resolveModelId(modelId);
    try {
      const client = await this.getClient();
      await client.models.generateContent({
        model: actualId,
        contents: "ping",
        config: { maxOutputTokens: 1 },
      });
      log(`    🏓 Google ${modelId} -> ${actualId} → ✅`);
      return true;
    } catch (e) {
      log(`    🏓 Google ${modelId} -> ${actualId} → ❌ ${e}`);
      return false;
    }
  }

  async provideTokenCount(text: string | vscode.LanguageModelChatRequestMessage, _token: vscode.CancellationToken): Promise<number> {
    if (typeof text === "string") {
      return Math.ceil(text.length / 4);
    }
    let length = 0;
    for (const part of text.content) {
      if (part instanceof vscode.LanguageModelTextPart) {
        length += part.value.length;
      }
    }
    return Math.ceil(length / 4);
  }

  private mapRole(roleNum: number): string {
    if (roleNum === vscode.LanguageModelChatMessageRole.User) {
      return "user";
    }
    if (roleNum === vscode.LanguageModelChatMessageRole.Assistant) {
      return "model";
    }
    return "system";
  }

  private mapToolResult(p: vscode.LanguageModelToolResultPart): any {
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

    try {
      return { functionResponse: { name: p.callId, response: JSON.parse(resStr) } };
    } catch {
      return { functionResponse: { name: p.callId, response: { result: resStr } } };
    }
  }

  private extractMessages(messages: readonly vscode.LanguageModelChatRequestMessage[], charCount: any): { mappedContents: any[]; systemInstruction: string } {
    const mappedContents: any[] = [];
    let systemInstruction = "";

    for (const msg of messages) {
      const roleName = this.mapRole(msg.role);

      if (roleName === "system") {
        for (const p of msg.content) {
          if (p instanceof vscode.LanguageModelTextPart) {
            systemInstruction += p.value + "\n";
            charCount.system += p.value.length;
          }
        }
        continue; // System instructions are passed separately in Gemini
      }

      const parts: any[] = [];
      for (const p of msg.content) {
        if (p instanceof vscode.LanguageModelTextPart) {
          if (p.value.length > 0) {
            parts.push({ text: p.value });
            if (roleName === "user") {
              charCount.user_text += p.value.length;
            } else {
              charCount.assistant_text += p.value.length;
            }
          }
        } else if (p instanceof vscode.LanguageModelToolCallPart) {
          // Re-inject thought signature if we cached one for this tool call.
          // Thinking models require the thought part (with its signature) to be
          // present before its associated function call in subsequent turns.
          const cachedSig = this.thoughtSignatureCache.get(p.callId);
          if (cachedSig) {
            parts.push({ thought: true, thoughtSignature: cachedSig });
          }
          parts.push({
            functionCall: { name: p.name, args: p.input },
          });
          charCount.tool_use += JSON.stringify(p.input).length + p.name.length;
        } else if (p instanceof vscode.LanguageModelToolResultPart) {
          parts.push(this.mapToolResult(p));
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
              // ignore unparseable data part
              log(`⚠️  Unparseable data part: ${e}`);
            }
          }
        }
      }

      if (parts.length > 0) {
        mappedContents.push({ role: roleName, parts });
      } else {
        mappedContents.push({ role: roleName, parts: [{ text: " " }] });
      }
    }

    // Make sure first non-system message is from user
    if (mappedContents.length === 0 || mappedContents[0].role !== "user") {
      mappedContents.unshift({ role: "user", parts: [{ text: " " }] });
    }

    return { mappedContents, systemInstruction };
  }

  async provideLanguageModelChatResponse(
    modelId: string,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<ChatInferenceResult> {
    const { actualId, config } = this.resolveModelId(modelId);
    log(`▶ Google provideLanguageModelChatResponse called — requested: ${modelId} -> executed: ${actualId}, msgs: ${messages.length}`);

    const charCount = { system: 0, user_text: 0, assistant_text: 0, image: 0, tool_use: 0, tool_result: 0 };
    let inputTokens = 0,
      outputTokens = 0,
      cacheRead = 0,
      cacheCreate = 0;

    try {
      const { mappedContents, systemInstruction } = this.extractMessages(messages, charCount);

      const generationConfig: any = { ...config };

      if (systemInstruction.trim().length > 0) {
        generationConfig.systemInstruction = systemInstruction.trim();
      }

      if (options.tools && options.tools.length > 0) {
        const declarations = options.tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.inputSchema || { type: "object", properties: {} },
        }));
        generationConfig.tools = [{ functionDeclarations: declarations }];
        log(`  🔧 Provided ${declarations.length} tools`);
      }

      const client = await this.getClient();
      const stream = await client.models.generateContentStream({
        model: actualId,
        contents: mappedContents,
        config: generationConfig,
      });

      // Accumulate thought signatures from this turn so they can be associated
      // with any function calls that follow them in the same response.
      let pendingThoughtSignature: string | undefined;

      for await (const chunk of stream) {
        if (token.isCancellationRequested) {
          break;
        }

        // Collect thought parts (with signatures) from raw candidate parts.
        // These must not be forwarded as text but must be cached for re-use.
        const rawParts: any[] | undefined = chunk.candidates?.[0]?.content?.parts;
        if (rawParts) {
          for (const part of rawParts) {
            if (part.thought === true && part.thoughtSignature) {
              pendingThoughtSignature = part.thoughtSignature;
            }
          }
        }

        const functionCalls = chunk.functionCalls;
        if (functionCalls && functionCalls.length > 0) {
          for (const fc of functionCalls) {
            const callName = fc.name || "unknown";
            // Associate the accumulated thought signature with this tool call ID.
            if (pendingThoughtSignature) {
              this.thoughtSignatureCache.set(callName, pendingThoughtSignature);
              pendingThoughtSignature = undefined;
            }
            progress.report(new vscode.LanguageModelToolCallPart(callName, callName, fc.args || {}));
          }
        }

        // chunk.text already strips thought parts, so it is safe to forward.
        if (chunk.text) {
          charCount.assistant_text += chunk.text.length;
          progress.report(new vscode.LanguageModelTextPart(chunk.text));
        }

        if (chunk.usageMetadata) {
          inputTokens = chunk.usageMetadata.promptTokenCount ?? inputTokens;
          outputTokens = chunk.usageMetadata.candidatesTokenCount ?? outputTokens;
        }
      }

      log(`  ✅ Stream finished successfully`);

      return {
        usage: { input: inputTokens, output: outputTokens, cache_read: cacheRead, cache_create: cacheCreate },
        charCount,
      };
    } catch (e) {
      log(`  ❌ Google provideLanguageModelChatResponse error: ${e}`);
      throw e;
    }
  }
}
