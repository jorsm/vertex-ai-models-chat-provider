const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomBytes, randomInt, createHash } = require("node:crypto");
const vscode = require("vscode");
const { PROVIDERS, FEATURES, safeError, completeReport, blockPending, makeImageChallenge } = require("./support.cjs");

exports.run = async function () {
    const reportPath = process.env.VERTEX_LIVE_REPORT;
    const configuration = JSON.parse(process.env.VERTEX_LIVE_CONFIGURATION);
    const report = JSON.parse(await fs.readFile(reportPath, "utf8"));
    const persist = () => fs.writeFile(reportPath, JSON.stringify(report, null, 4));
    const deadline = async (operation, name, seconds = configuration.requestTimeoutSeconds) => {
        const cancellation = new vscode.CancellationTokenSource();
        let timer;
        try {
            return await Promise.race([
                operation(cancellation.token),
                new Promise((_, reject) => {
                    timer = setTimeout(() => {
                        cancellation.cancel();
                        reject(new Error(`${name} exceeded ${seconds}s (request canceled).`));
                    }, seconds * 1000);
                }),
            ]);
        } finally {
            clearTimeout(timer);
            cancellation.dispose();
        }
    };
    const collect = async (model, messages, options, token) => {
        const response = await model.sendRequest(messages, options, token);
        const parts = [];
        let text = "";
        let textParts = 0;
        for await (const part of response.stream) {
            if (part instanceof vscode.LanguageModelTextPart) {
                text += part.value;
                textParts++;
                parts.push(part);
            } else if (part instanceof vscode.LanguageModelToolCallPart) {
                parts.push(part);
            }
        }
        return { text, textParts, parts, calls: parts.filter((part) => part instanceof vscode.LanguageModelToolCallPart) };
    };
    const check = async (provider, feature, operation) => {
        const started = Date.now();
        const entry = { provider, feature, model: configuration.models[provider] };
        try {
            entry.evidence = await deadline(operation, `${provider} ${feature}`);
            entry.status = "passed";
        } catch (error) {
            entry.status = "failed";
            entry.error = safeError(error);
        }
        entry.durationMs = Date.now() - started;
        report.checks.push(entry);
        await persist();
    };

    try {
        const extension = vscode.extensions.getExtension("jorsm.vertex-ai-models-chat-provider");
        assert.ok(extension, "The packaged extension must be installed.");
        assert.ok(extension.extensionPath.startsWith(process.env.VERTEX_LIVE_EXTENSIONS + path.sep), "The product must resolve to the isolated VSIX installation.");
        assert.ok(!extension.extensionPath.startsWith(process.env.VERTEX_LIVE_REPOSITORY + path.sep), "The product must not resolve to the source checkout.");
        const settings = vscode.workspace.getConfiguration("vertexAiChat");
        assert.equal(settings.get("projectId"), "", "Keep the project empty until ADC and the scoped catalog are ready.");
        assert.equal(settings.inspect("proxyUrl").globalValue, "");
        await deadline(() => extension.activate(), "extension activation");

        // Seed from the installed bundle, including when testing an externally supplied VSIX.
        await vscode.commands.executeCommand("vertexAiChat.openWorkspaceModelsFile");
        const catalogPath = path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, ".vscode", "models.json");
        const catalog = JSON.parse(await fs.readFile(catalogPath, "utf8"));
        const vendors = { gemini: "google", claude: "anthropic" };
        const selected = PROVIDERS.map((provider) => {
            const spec = catalog.candidateModels.find((model) => model.id === configuration.models[provider]);
            assert.ok(spec, `${provider}: configured model is absent from the packaged catalog: ${configuration.models[provider]}`);
            assert.equal(spec.vendor, vendors[provider]);
            assert.equal(spec.family, provider);
            assert.ok(spec.capabilities.imageInput && spec.capabilities.toolCalling, `${provider}: selected model must support tools and images.`);
            return { ...spec, maxOutputTokens: Math.min(spec.maxOutputTokens, 2048) };
        });
        await fs.writeFile(catalogPath, JSON.stringify({ candidateModels: selected, regionPriority: [configuration.region] }, null, 4));
        // Allow the catalog watcher to settle before any inference/discovery starts.
        await new Promise((resolve) => setTimeout(resolve, 700));
        report.host = { version: vscode.version, extensionVersion: extension.packageJSON.version, extensionMode: "production" };
        report.catalog = { source: "seeded by installed extension", maxOutputTokens: 2048, models: selected.map(({ id, vendor, version, effort, maxOutputTokens }) => ({ id, vendor, version, effort, maxOutputTokens })) };
        await persist();
        // Clear ADC while the project is empty: dismiss only the missing-project
        // notifications in this isolated profile so the public command can finish.
        assert.ok((await vscode.commands.getCommands(true)).includes("notifications.clearAll"));
        await deadline(
            async (token) => {
                let pending = true;
                let failure;
                const selection = vscode.commands.executeCommand("vertexAiChat.clearAuthMethod").then(
                    () => {
                        pending = false;
                    },
                    (error) => {
                        pending = false;
                        failure = error;
                    },
                );
                try {
                    while (pending && !token.isCancellationRequested) {
                        await vscode.commands.executeCommand("notifications.clearAll");
                        await new Promise((resolve) => setTimeout(resolve, 75));
                    }
                    if (token.isCancellationRequested) throw new vscode.CancellationError();
                    await selection;
                    if (failure) throw failure;
                } finally {
                    pending = false;
                }
            },
            "select ADC before cloud discovery",
            10,
        );
        // Used only by the separate, non-network desktop fixture. Never qualifies for release.
        if (process.env.VERTEX_LIVE_BOOTSTRAP_ONLY === "1") {
            report.setup = { status: "passed", bootstrapOnly: true };
            blockPending(report, "Desktop bootstrap verified; no cloud requests were executed.");
            await persist();
            return;
        }
        await settings.update("projectId", configuration.project, vscode.ConfigurationTarget.Global);
        await deadline(() => vscode.commands.executeCommand("vertexAiChat.refreshModels"), "explicit model refresh", 180);
        const models = await deadline(() => vscode.lm.selectChatModels({ vendor: "google-vertex" }), "model discovery", 180);
        report.discoveredModels = models.map(({ id, family, version, vendor }) => ({ id, family, version, vendor }));
        report.setup = { status: "passed" };
        await persist();

        for (const provider of PROVIDERS) {
            const spec = selected.find((candidate) => candidate.family === provider);
            const matches = models.filter((model) => model.vendor === "google-vertex" && model.family === provider && model.version === spec.version);
            if (matches.length !== 1) {
                for (const feature of FEATURES) report.checks.push({ provider, feature, model: spec.id, status: "failed", error: "The exact configured model was not discovered through direct ADC. Check model enablement, region, permissions and the host logs." });
                await persist();
                continue;
            }
            const model = matches[0];
            await check(provider, "chat", async (token) => {
                const nonce = `CHAT_${randomBytes(8).toString("hex")}`;
                const response = await collect(model, [vscode.LanguageModelChatMessage.User(`Reply with exactly ${nonce} and no other text.`)], {}, token);
                assert.equal(response.text.trim(), nonce, "Chat response must follow the request.");
                assert.ok(response.textParts > 0);
                assert.equal(response.calls.length, 0);
                return { reply: response.text.trim(), textParts: response.textParts };
            });
            await check(provider, "tools", async (token) => {
                const left = randomInt(100, 1000);
                const right = randomInt(100, 1000);
                const tools = [
                    {
                        name: "acceptance_add",
                        description: "Adds two integers and returns a receipt. Use this tool before answering; return only its receipt afterward.",
                        inputSchema: {
                            type: "object",
                            properties: { left: { type: "integer" }, right: { type: "integer" } },
                            required: [
                                "left",
                                "right",
                            ],
                            additionalProperties: false,
                        },
                    },
                ];
                const user = vscode.LanguageModelChatMessage.User(`Call acceptance_add with left=${left} and right=${right}. Do not calculate yourself. After the tool returns, reply with only its receipt.`);
                const first = await collect(model, [user], { tools, toolMode: vscode.LanguageModelChatToolMode.Required }, token);
                assert.equal(first.calls.length, 1, "The model must emit exactly one actual tool call.");
                const call = first.calls[0];
                assert.equal(call.name, "acceptance_add");
                assert.ok(typeof call.callId === "string" && call.callId.length > 0);
                assert.deepEqual(call.input, { left, right });
                const receipt = `TOOL_${randomBytes(12).toString("hex")}`;
                const result = { sum: call.input.left + call.input.right, receipt };
                const history = [
                    user,
                    vscode.LanguageModelChatMessage.Assistant(first.parts),
                    vscode.LanguageModelChatMessage.User([new vscode.LanguageModelToolResultPart(call.callId, [new vscode.LanguageModelTextPart(JSON.stringify(result))])]),
                ];
                const continuation = await collect(model, history, { tools }, token);
                assert.equal(continuation.calls.length, 0, "The continuation must finish without another tool call.");
                assert.equal(continuation.text.trim(), receipt, "The model must read the receipt supplied only inside the tool result.");
                return { tool: call.name, input: call.input, sum: result.sum, continuation: continuation.text.trim() };
            });
            await check(provider, "image", async (token) => {
                const image = makeImageChallenge();
                const prompt = "Read the five large colored squares in the attached image from left to right. Reply only with their color names, separated by commas. Use these names: red, green, blue, yellow, purple. Do not include any other text.";
                const message = vscode.LanguageModelChatMessage.User([
                    new vscode.LanguageModelTextPart(prompt),
                    vscode.LanguageModelDataPart.image(image.png, "image/png"),
                ]);
                const response = await collect(model, [message], {}, token);
                const actual = response.text.trim().toLowerCase().replace(/\s+/g, "");
                assert.equal(actual, image.expected, "The answer must match the random order encoded only in the image pixels.");
                assert.equal(response.calls.length, 0);
                return { expected: image.expected, actual, imageSha256: createHash("sha256").update(image.png).digest("hex") };
            });
        }
        completeReport(report);
    } catch (error) {
        report.setup = { status: "failed", error: safeError(error) };
        blockPending(report, report.setup.error);
    }
    await persist();
    assert.ok(report.releaseEligible, "Live acceptance failed. Read the JSON report for the required provider/feature failures.");
};
