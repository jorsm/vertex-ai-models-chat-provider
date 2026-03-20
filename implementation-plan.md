# Implementation Plan: VS Code Chat Model Provider for Vertex AI Anthropic

## 1. Project Goal
Create a VS Code extension that implements the `vscode.LanguageModelChatProvider` API. This extension will act as a bridge, allowing the native VS Code Chat UI (e.g., GitHub Copilot Chat view) to send prompts to and receive streaming responses from Anthropic Claude models hosted on Google Cloud Vertex AI (Model Garden).

## 2. Useful Resources for the Agent
* **VS Code Chat Provider Sample:** `https://github.com/microsoft/vscode-extension-samples/tree/main/chat-model-provider-sample`
* **VS Code Extension API Docs:** `https://code.visualstudio.com/api`
* **Anthropic Vertex SDK Docs:** `https://www.npmjs.com/package/@anthropic-ai/vertex-sdk`
* **Google Auth Library (ADC):** `https://cloud.google.com/docs/authentication/application-default-credentials`

## 3. How to Build and Test (Developer Workflow)
1. **Scaffold:** Run `npx yo code` in the terminal to generate a basic TypeScript VS Code extension.
2. **Compile:** Run `npm run watch` to start the TypeScript compiler in watch mode.
3. **Debug/Test:** Press `F5` in VS Code to launch the **Extension Development Host**. This opens a new VS Code window with the extension loaded.
4. **Interact:** In the Extension Development Host, open the Chat view (Copilot icon), type `@` to select the newly registered model (e.g., `@vertex-anthropic`), and send a prompt. 
5. **Reload:** If code changes are made, press `Cmd+R` (Mac) or `Ctrl+R` (Windows) in the Extension Development Host to reload it.

---

## 4. Agent Implementation Steps

### Phase 1: Project Setup & Dependencies
1. **Initialize Project:** Scaffold a standard VS Code extension using TypeScript (if not already done).
2. **Install SDK:** Run `npm install @anthropic-ai/vertex-sdk`.
3. **Engine Version:** Ensure the `engines.vscode` in `package.json` is at least `^1.90.0` (or whatever the current stable release is that supports the language model API without proposed flags).

### Phase 2: Configuration (`package.json`)
1. **Define the Provider:** Add the `languageModelChatProviders` contribution point.
    ```json
    "contributes": {
      "languageModelChatProviders": [
        {
          "identifier": "vertex-anthropic",
          "name": "Vertex Claude 3.5 Sonnet"
        }
      ]
    }
    ```
2. **Add Settings:** Add extension settings (`configuration` contribution point) for:
    * `vertexAnthropic.projectId`: The GCP Project ID (string).
    * `vertexAnthropic.region`: The GCP Region, default to `us-central1` (string).

### Phase 3: Extension Activation (`extension.ts`)
1. **Import API:** Import `vscode`.
2. **Register Provider:** In the `activate` function, read the `projectId` and `region` from `vscode.workspace.getConfiguration('vertexAnthropic')`.
3. **Instantiate Provider:** Create an instance of the provider class (to be built in Phase 4) passing the config.
4. **Register:** Call `vscode.lm.registerLanguageModelChatProvider('vertex-anthropic', new VertexAnthropicProvider(...))`.
5. **Push to Subscriptions:** Add the resulting disposable to `context.subscriptions`.

### Phase 4: Provider Implementation (`VertexAnthropicProvider.ts`)
Create a class that implements `vscode.LanguageModelChatProvider`.

1. **Initialization:** Initialize the `AnthropicVertex` client in the constructor using the provided region and projectId.
2. **`provideLanguageModelChatInformation`:** * Return metadata. Make sure `name` and `identifier` match `package.json`. 
    * Include a dummy or generic `tokenCount` limit.
3. **`provideTokenCount`:**
    * Implement a basic token estimation logic (e.g., `text.length / 4`) since Anthropic's local token counting isn't perfectly synchronous without heavy libraries.
4. **`provideLanguageModelChatResponse` (The Core Logic):**
    * **Map Messages:** Iterate over the incoming `vscode.LanguageModelChatMessage[]`. 
        * If `role === vscode.LanguageModelChatMessageRole.User`, map to Anthropic `'user'`.
        * If `role === vscode.LanguageModelChatMessageRole.Assistant`, map to Anthropic `'assistant'`.
        * Extract the text by iterating over `content` and checking `part instanceof vscode.LanguageModelTextPart`.
    * **API Call:** Call `client.messages.create({...})`.
        * Set `model` to `'claude-3-5-sonnet-v2@20241022'` (or allow this to be a setting).
        * Pass the mapped messages.
        * Set `stream: true`.
        * Set `max_tokens: 4096`.
    * **Handle Streaming:** Create an `async function*` generator.
        * Loop `for await (const chunk of stream)`.
        * Check `extensionToken.isCancellationRequested`. If true, break the loop.
        * If `chunk.type === 'content_block_delta' && chunk.delta.type === 'text_delta'`, yield a new `vscode.LanguageModelTextPart(chunk.delta.text)`.
    * **Return:** Return `{ stream: yourGeneratorFunction() }`.

### Phase 5: Authentication Pre-flight (Developer Note)
* The agent does not need to write complex auth code. The `@anthropic-ai/vertex-sdk` uses standard Application Default Credentials (ADC). 
* **Requirement before testing:** The user must run `gcloud auth application-default login` in their local terminal before launching the VS Code Extension Development Host.