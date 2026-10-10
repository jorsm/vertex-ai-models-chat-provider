const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const vscode = require("vscode");
exports.run = async () => {
    const results = [];
    const cancellation = new vscode.CancellationTokenSource();
    const record = (check) => results.push({ check, result: "passed" });
    try {
        const extension = vscode.extensions.getExtension("jorsm.vertex-ai-models-chat-provider");
        assert(extension);
        await extension.activate();
        assert((await vscode.commands.getCommands(true)).includes("vertexAiChat.configureThinkingEffort"));
        record("Extension activation and stable command registration");
        const root = require("node:path").resolve(__dirname, "../..");
        const { VertexChatModelDispatcher } = require(root + "/out/VertexChatModelDispatcher.js");
        const { writeEffortPreference, captureEffortPreferences } = require(root + "/out/effort/EffortConfiguration.js");
        const models = require(root + "/src/models.json").candidateModels;
        class Fixture extends VertexChatModelDispatcher {
            registerProviders() {}
        }
        const captured = [],
            records = [];
        const d = new Fixture(
            "fixture-project",
            { recordUsage: async (...args) => records.push(args) },
            { onAuthUpdated: () => new vscode.Disposable(() => {}), getResolvedAuthOptions: async () => undefined },
            { getEffectiveCatalog: async () => ({ candidateModels: models, regionPriority: ["global"] }) },
        );
        d.availableModels = models;
        d.discoveryDone = true;
        d.activeProviders.set("anthropic", {
            vendor: "anthropic",
            provideLanguageModelChatResponse: async (...args) => {
                captured.push(args[7]);
                return { usage: { input: 1, output: 1 }, charCount: {} };
            },
        });
        const persisted = vscode.workspace.getConfiguration("vertexAiChat").inspect("thinkingEffortByModel")?.globalValue;
        if (process.env.VERTEX_EFFORT_EXPECT_PERSISTED === "1") {
            assert.equal(persisted?.["claude-opus-5-5"], "max");
            record("User preference survives desktop host restart");
        }
        await writeEffortPreference("claude-opus-5-5", "max", vscode.ConfigurationTarget.Global);
        await writeEffortPreference("claude-opus-5-5", "high", vscode.ConfigurationTarget.Workspace);
        assert.equal(captureEffortPreferences().sourceByModel["claude-opus-5-5"], "workspace");
        record("Real User/Workspace configuration writes and precedence without resource URI");
        const config = vscode.workspace.getConfiguration("vertexAiChat");
        assert.equal(config.inspect("thinkingEffortByModel").globalValue["claude-opus-5-5"], "max");
        assert.equal(config.inspect("thinkingEffortByModel").workspaceValue["claude-opus-5-5"], "high");
        await d.provideLanguageModelChatResponse({ id: "claude-opus-5-5" }, [], {}, { report() {} }, cancellation.token);
        await d.infer("claude-opus-5-5", [], {}, { report() {} }, cancellation.token);
        assert.deepEqual(
            captured.map((r) => r.effort.value),
            [
                "high",
                "medium",
            ],
        );
        record("Public provider snapshot and named catalog default");
        assert.equal((await d.provideLanguageModelChatInformation({}, cancellation.token)).length, 15);
        record("Only canonical models advertised in desktop extension host");
        const quick = vscode.window.createQuickPick();
        quick.title = "Thinking Effort fixture";
        quick.items = [
            { label: "Medium", description: "Default", value: "medium" },
            { label: "High", value: "high" },
            { label: "Max", value: "max" },
        ];
        quick.activeItems = [quick.items[0]];
        quick.show();
        assert.equal(quick.activeItems[0].label, "Medium");
        assert.equal(quick.activeItems[0].description, "Default");
        quick.hide();
        quick.dispose();
        record("Stable QuickPick named default with secondary description and activeItems");
        await writeEffortPreference("claude-opus-5-5", "medium", vscode.ConfigurationTarget.Workspace);
        assert.equal(captureEffortPreferences().preferences["claude-opus-5-5"], "medium");
        record("Named Workspace default overrides User value");
        await writeEffortPreference("claude-opus-5-5", undefined, vscode.ConfigurationTarget.Workspace);
        assert.equal(captureEffortPreferences().preferences["claude-opus-5-5"], "max");
        record("Workspace removal reveals real User value");
        assert.equal(records.length, 2);
        d.dispose();
    } catch (error) {
        results.push({ check: "Host fixture", result: "failed", detail: error.stack });
        throw error;
    } finally {
        cancellation.dispose();
        await fs.writeFile(
            process.env.VERTEX_EFFORT_HOST_RESULTS || "/tmp/vertex-effort-host/results.json",
            JSON.stringify({ version: vscode.version, commit: require(vscode.env.appRoot + "/product.json").commit, platform: process.platform, arch: process.arch, osRelease: require("node:os").release(), remoteName: vscode.env.remoteName ?? null, results }, null, 2) + "\n",
        );
    }
};
