const assert = require("node:assert/strict");
const Module = require("node:module");
const test = require("node:test");

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "vscode") {
    return {
      window: {
        createOutputChannel: () => ({
          appendLine: () => {},
        }),
      },
      workspace: {
        getConfiguration: () => ({
          get: (key) => "",
        }),
      },
      extensions: {
        getExtension: () => null,
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

let DEFAULT_SYSTEM_PROMPT;
let resolveCommitMessageResourceUri;
try {
  ({ DEFAULT_SYSTEM_PROMPT, resolveCommitMessageResourceUri } = require("../out/CommitMessage.js"));
} finally {
  Module._load = originalLoad;
}

test("exports default conventional commit system prompt", () => {
  assert.ok(DEFAULT_SYSTEM_PROMPT);
  assert.match(DEFAULT_SYSTEM_PROMPT, /Conventional Commits/);
  assert.match(DEFAULT_SYSTEM_PROMPT, /<type>\(<scope>\): <subject>/);
});

test("resolves the repository URI from an SCM title command context", () => {
  const rootUri = { scheme: "file", fsPath: "/workspace/repository" };

  assert.equal(resolveCommitMessageResourceUri({ rootUri }), rootUri);
  assert.equal(resolveCommitMessageResourceUri(rootUri), rootUri);
  assert.equal(resolveCommitMessageResourceUri(undefined), undefined);
});
