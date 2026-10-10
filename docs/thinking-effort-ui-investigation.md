# Thinking effort selection in VS Code Chat: investigation and agent handoff

Prepared on **8 October 2026** for an AI agent continuing work on `vertex-ai-models-chat-provider`. This document records the product goal, existing implementation, investigated alternatives, runtime evidence, limitations, and remaining decisions. Creating this document does not implement an effort setting or change inference behavior.

## 1. Goal and user preferences

The extension contributes models through `vscode.LanguageModelChatProvider` to VS Code's existing Chat UI. Model identity is separate from thinking/reasoning configuration. The supported implementation uses named per-model preferences and catalog defaults; see the [current contract](thinking-effort-implementation-plan.md).

The desired outcome is one model identity with an independently selected, persisted effort preference. The extension must receive that preference and translate it into the correct backend request. A visible dropdown alone does not establish that the selected effort reaches inference.

Relevant preferences established in the conversation:

- The user changes effort infrequently and generally does not need a different value for every chat session. A persistent preference is a reasonable design candidate, but its precise scope has not been approved.
- The bottom area of VS Code can already be crowded. Adding a permanent status bar item is less attractive than a Chat-adjacent control.
- The user likes the gear/button approach and requested a gear with a **Thinking Effort** tooltip, a text variant for comparison, and a dummy effort picker.
- The UI experiment was explicitly visual-only: no real model selection, saved preference, or request changes were required.
- After the toolbar failure was demonstrated, the user explicitly asked to add the `chat/input/status` contribution anyway, retaining the header menu as a comparison.
- The user follows the live preview and requested that screenshots not be sent repeatedly.

## 2. Current repository state versus the earlier prototype

The inspected checkout is on `codex/cloud-function-proxy`, at HEAD `d4867a5`, with a working manifest version of `0.7.4`. Several unrelated files already have staged or unstaged changes. Do not discard or overwrite that work while implementing this feature.

**The earlier effort preview is not present in the current `package.json` or `src/extension.ts`.** The local branch `codex/chat-effort-toolbar-preview` still exists, but its tracked tip is `d2d6ee8` and does not contain the preview declarations. The earlier prototype was uncommitted; the branch name alone is not a recoverable implementation snapshot. This document describes the historical preview rather than asserting that it is currently shipped or installed.

Current code references, with symbol names to survive line-number changes:

| Code | Relevance |
| --- | --- |
| [package.json](../package.json) | `contributes.languageModelChatProviders` registers vendor `google-vertex`; provider-level configuration points to the Refresh Models management command. It does not declare an effort setting. The engine floor and `@types/vscode` dependency are `^1.110.0`. |
| [src/extension.ts](../src/extension.ts) | `activate()` registers `vscode.lm.registerLanguageModelChatProvider("google-vertex", provider)`, currently around line 61. No effort-preview commands are registered in this checkout. |
| [src/models.json](../src/models.json) | Bundled model definitions, each with a literal backend version and optional named effort choices/default. |
| [src/VertexChatModelDispatcher.ts](../src/VertexChatModelDispatcher.ts) | `mapModels()` around line 407 creates one Chat model per catalog entry. `provideLanguageModelChatResponse()` around line 513 calls `infer()`, and `inferWithLabels()` around line 620 resolves the selected catalog entry and provider. |
| [src/providers/ClaudeThinking.ts](../src/providers/ClaudeThinking.ts) | Builds adaptive-thinking request configuration and preserves signed thinking content across tool continuations. |
| [src/providers/VertexAnthropicProvider.ts](../src/providers/VertexAnthropicProvider.ts) | Around lines 101/134, resolves `spec?.version ?? modelId` and spreads the resulting effort configuration into the Anthropic request. Also owns signed thinking replay behavior that must remain intact. |
| [src/providers/VertexGoogleProvider.ts](../src/providers/VertexGoogleProvider.ts) | `resolveModelId()` around line 112 maps `-high` to `thinkingConfig.thinkingLevel = "HIGH"`. Inference resolves `spec?.version ?? modelId` around line 479. |
| [src/providers/VertexGrokProvider.ts](../src/providers/VertexGrokProvider.ts) | Maps independent effort to `reasoning_effort` and uses the literal catalog version. |
| [src/ModelCatalogResolver.ts](../src/ModelCatalogResolver.ts) | Custom workspace/user catalogs can replace the bundled catalog. In proxy mode, the server-provided catalog is authoritative, including an empty catalog. |
| [src/CostStatusBar.ts](../src/CostStatusBar.ts) | Existing cost item, created around line 21. Illustrates a supported, dynamically updateable status bar surface. |
| [src/DashboardWebview.ts](../src/DashboardWebview.ts) | Existing editor-area webview, created around line 20, with message handling around line 39. Illustrates a surface where the extension controls HTML and receives UI events. |

The dispatcher groups discovery by vendor and literal catalog backend version. Entries sharing that version share availability without changing inference effort.

## 3. Supported UI extension versus HTML injection

VS Code extensions have no supported access to the workbench DOM. A third-party extension cannot use the public API to insert arbitrary HTML into Copilot Chat's composer. An extension-owned webview can render custom HTML, but that HTML lives in the webview, not in the existing Chat input. Modifying installed workbench files or using a custom-CSS/injection mechanism would couple the feature to internal UI implementation and installation/update behavior. These techniques were not implemented or verified here. [VS Code extension restrictions](https://code.visualstudio.com/api/extension-capabilities/overview#restrictions).

Menu contributions offer supported insertion points for **commands and submenus**, not arbitrary DOM widgets. They let VS Code render the control and route a click to the extension host. This is why the investigation moved from HTML injection to a declarative command contribution.

## 4. Native per-model effort configuration: the best eventual integration

VS Code has native model configuration UI used by Copilot and built-in BYOK integrations. The relevant third-party hook is `LanguageModelChatInformation.configurationSchema`, with the resolved value exposed to a provider as `ProvideLanguageModelChatResponseOptions.modelConfiguration`. A schema property such as `reasoningEffort` can define allowed enum values, display labels, a default, and `group: "navigation"`. The exact presentation belongs to the host/version. [Proposed chatProvider declarations](https://github.com/microsoft/vscode/blob/49b24202921f02dc1215eb8db80d50ae239b3da7/src/vscode-dts/vscode.proposed.chatProvider.d.ts#L9-L27).

Conceptually, this provides the desired connection:

```text
provider returns model + effort schema
  -> VS Code renders and persists model configuration
  -> request options contain modelConfiguration.reasoningEffort
  -> provider translates that value into its backend-specific request
```

**The hook remains proposed as of this check.** Both fields are in `vscode.proposed.chatProvider.d.ts` and absent from the corresponding stable `vscode.d.ts`. End-user availability of a built-in picker does not establish a stable third-party API contract. [Configuration schema declaration](https://github.com/microsoft/vscode/blob/49b24202921f02dc1215eb8db80d50ae239b3da7/src/vscode-dts/vscode.proposed.chatProvider.d.ts#L82-L87), [stable declarations](https://github.com/microsoft/vscode/blob/49b24202921f02dc1215eb8db80d50ae239b3da7/src/vscode-dts/vscode.d.ts).

The documented proposal-development route uses Insiders, `enabledApiProposals: ["chatProvider"]`, and matching proposed typings. VS Code's published guidance says proposed APIs should not be used in Marketplace extensions. A Marketplace prerelease is not an exemption. This is the main distribution/support limitation of adopting the native hook now. [Using Proposed API](https://code.visualstudio.com/api/advanced-topics/using-proposed-api).

An important implementation nuance: the inspected `extHostLanguageModels.ts` copies `configurationSchema` into internal metadata and translates internal `options.configuration` to provider-facing `modelConfiguration` without an individual proposal check on those assignments. An untyped JavaScript/`any` experiment may therefore appear to work in a particular build. Do not claim an absolute runtime impossibility, or that a TypeScript cast creates a supported API. This would depend on behavior outside the stable contract and still require version-specific delivery and persistence tests. [Metadata conversion](https://github.com/microsoft/vscode/blob/49b24202921f02dc1215eb8db80d50ae239b3da7/src/vs/workbench/api/common/extHostLanguageModels.ts#L234-L266), [provider request conversion](https://github.com/microsoft/vscode/blob/49b24202921f02dc1215eb8db80d50ae239b3da7/src/vs/workbench/api/common/extHostLanguageModels.ts#L359-L368).

The current dispatcher already uses `any` for some internal/proposed visibility metadata. That existing practice is not evidence that configuration changes will persist or reach providers on every supported VS Code version.

For persistence/selection investigations, VS Code's own `ChatModelConfigurationStore` is also relevant: its `setModelConfiguration()`, `getModelConfiguration()`, and `restoreModelConfiguration()` handle host-owned values and per-editor state. This is distinct from an extension-owned preference stored in `vertexAiChat` settings. [Native configuration store](https://github.com/microsoft/vscode/blob/49b24202921f02dc1215eb8db80d50ae239b3da7/src/vs/workbench/contrib/chat/browser/widget/input/chatModelConfigurationStore.ts#L122-L155).

## 5. Reading menusExtensionPoint.ts correctly

Use the exposed `apiMenus` entries and contribution validation, rather than assuming every internal `MenuId` is available to third-party extensions.

- `proposed: "someProposal"` means the menu contribution is guarded by that proposal. Absence of `proposed` removes this particular gate; it does not establish compatibility with older VS Code builds or guarantee bug-free execution.
- `supportsSubmenus` defaults to `true`. A value of `false` forbids contributing a nested submenu to that location. It does **not** forbid a command from opening a QuickPick.
- `chat/input/status` is exposed without a `proposed` flag and with `supportsSubmenus: false`.
- `view/title` is exposed without a `proposed` flag and supports submenus through the default.

References: [menu metadata](https://github.com/microsoft/vscode/blob/49b24202921f02dc1215eb8db80d50ae239b3da7/src/vs/workbench/services/actions/common/menusExtensionPoint.ts#L30-L35), [Chat status location](https://github.com/microsoft/vscode/blob/49b24202921f02dc1215eb8db80d50ae239b3da7/src/vs/workbench/services/actions/common/menusExtensionPoint.ts#L147-L151), [contribution validation](https://github.com/microsoft/vscode/blob/49b24202921f02dc1215eb8db80d50ae239b3da7/src/vs/workbench/services/actions/common/menusExtensionPoint.ts#L1085-L1115).

**Correction to a possible misunderstanding in the conversation:** QuickPick itself is available and works. The failing component was the Chat input toolbar's command invocation. Submenu restrictions and picker availability are separate questions.

## 6. Chat input gear: preferred placement, confirmed failure in the tested runtime

The historical contribution reused the existing preview command:

```json
"chat/input/status": [
  {
    "command": "vertexAiChat.previewThinkingEffort",
    "group": "navigation@1"
  }
]
```

Its command declaration used `title: "Thinking Effort"` and `icon: "$(settings-gear)"`. VS Code rendered the gear in the status area beneath the Chat input. Clicking it did not open the picker.

### Minimal reproduction and debugger evidence

On 5 October, a separate extension with a fresh user-data directory and extension directory was tested. It registered one command, `chatToolbarCheck.showPicker`, whose callback accepted no arguments and only called `vscode.window.showQuickPick()` with five dummy values. The exact same command was contributed to the Chat header and Chat input status toolbar and was available in the Command Palette. The Vertex provider was not part of this minimal fixture.

| Invocation | Observed outcome |
| --- | --- |
| Command Palette | The five-item picker opened. |
| Chat header (`view/title`) | The same picker opened. |
| Beneath Chat input (`chat/input/status`) | No picker opened; debugger captured a circular JSON exception. |

Tested environment: **code-server 4.139.1 / VS Code 1.139.1**, build `53c2f3253bcf32886706fc023e794bbeb253c90f`.

These were local UI/command tests. No Vertex inference request was used to verify a chosen effort, and this handoff did not rerun the UI experiment.

The debugger paused on:

```text
TypeError: Converting circular structure to JSON
  JSON.stringify
  serializeRequestArguments
  RPC _remoteCall
  contributed-command proxy
  executeCommand
  MenuItemAction.run
  toolbar onClick
```

Inspection at the serialization frame returned:

```json
{
  "command": "chatToolbarCheck.showPicker",
  "argumentCount": 1,
  "argumentKeys": ["widget"],
  "widgetClass": "Hb"
}
```

The circular object graph included `logService`, `_logger`, and `fileService`. Minified constructor names are incidental; the command ID, argument shape, and failure location are the useful evidence.

### Root cause

The status toolbar is constructed with argument forwarding enabled and context `{ widget }`. `MenuItemAction.run()` includes that context in the command arguments. The registered extension command is proxied to the extension host, and RPC serializes the arguments before invoking the callback. The widget contains circular internal service references, so serialization throws. [Status toolbar creation](https://github.com/microsoft/vscode/blob/49b24202921f02dc1215eb8db80d50ae239b3da7/src/vs/workbench/contrib/chat/browser/widget/input/chatInputPart.ts#L4145-L4153), [MenuItemAction.run](https://github.com/microsoft/vscode/blob/49b24202921f02dc1215eb8db80d50ae239b3da7/src/vs/platform/actions/common/actions.ts#L650-L663), [command proxy](https://github.com/microsoft/vscode/blob/49b24202921f02dc1215eb8db80d50ae239b3da7/src/vs/workbench/api/browser/mainThreadCommands.ts#L57-L65), [RPC request serialization](https://github.com/microsoft/vscode/blob/49b24202921f02dc1215eb8db80d50ae239b3da7/src/vs/workbench/services/extensions/common/rpcProtocol.ts#L465-L480).

Consequences:

- Removing callback parameters or ignoring the argument cannot fix it: the callback has not been reached.
- A callback-level `try/catch` cannot intercept that upstream failure.
- Changing the icon or command title does not change the problematic argument.
- Built-in workbench commands can execute without the same extension-host serialization boundary. Their success is not a valid control for a contributed command.
- The manifest entry can be valid and the button can render while invocation remains broken.

### Confidence boundary and current source inspection

The bug was **live-reproduced in the browser runtime above**. Desktop 1.140.0 had identical wiring but was not clicked directly during that investigation.

On 8 October, installed desktop VS Code is **1.141.0**, commit `2a59476c9bfcb90b3ddc372c36762471b7dfad1c`. Its source still uses the same forwarding/context combination. Current upstream HEAD `49b24202921f02dc1215eb8db80d50ae239b3da7` does too. These are source confirmations; desktop 1.141.0 and current Insiders have **not** received a new live click test for this handoff. Do not upgrade this evidence to a claim that every current desktop build has been reproduced. [Desktop 1.141 source](https://github.com/microsoft/vscode/blob/2a59476c9bfcb90b3ddc372c36762471b7dfad1c/src/vs/workbench/contrib/chat/browser/widget/input/chatInputPart.ts#L4108-L4115).

The old temporary fixture and `/tmp/vscode-chat-toolbar-check.yn7o2nbz/verification.md` are no longer available in this environment. They are historical paths, not usable deliverable links. A future reproduction should create a fresh minimal extension, run the three invocation paths above, pause on caught exceptions, inspect only the command ID and argument keys, and restore debugger state afterward.

An upstream repair would need to stop forwarding the internal widget to contributed commands or replace it with an explicitly serializable context. That is an architectural direction, not an implemented/tested patch; built-in consumers and any context requirements must be checked before changing VS Code itself.

## 7. Chat header menu: the working comparison

The historical working alternative used `view/title` and a contributed submenu with a gear icon. Its placement was declared in **package.json**, not in the command handler:

```json
"view/title": [
  {
    "submenu": "vertexAiChat.thinkingEffortPreviewMenu",
    "when": "view == workbench.panel.chat.view.copilot",
    "group": "navigation@3"
  }
]
```

`workbench.panel.chat.view.copilot` was the exact view ID verified in the experiment; `workbench.panel.chat` is a container identifier and was not interchangeable for this condition. Recheck the ID when targeting another host/version.

The submenu contained `Default`, `Low`, `Medium`, `High (preview value)`, and `Max`, each backed by a separate no-op command. Opening it and clicking Low worked in the preview. The standalone preview command also opened a native QuickPick titled **Thinking Effort — Example Model**, with High initially active. Accepting a value simply closed it. No choice was saved or translated to inference, and the example model was not derived from the active Chat model.

The header context is a compact object containing session/input URIs and a Chat context marshalling marker, rather than the complete internal widget. That explains why this path avoids the observed serialization failure. [ChatViewPane.getActionsContext](https://github.com/microsoft/vscode/blob/49b24202921f02dc1215eb8db80d50ae239b3da7/src/vs/workbench/contrib/chat/browser/widgetHosts/viewPane/chatViewPane.ts#L1889-L1895).

Why it remains suboptimal:

- It sits above the conversation rather than beside the selected model and effort.
- A header menu can crowd existing actions or end up in overflow at small widths.
- A generic gear communicates a configuration action but does not expose the current effort at a glance.
- The menu context does not itself supply a supported selected-model/effort object. There is no stable public API in the inspected declarations that gives this provider's arbitrary command access to the active Copilot Chat model selection. A real picker would need explicit model selection or a clearly defined extension-owned default scope.
- The prototype establishes the interaction/placement only, not functional correctness.

## 8. Icons, text, and dynamic state

`"icon": "$(settings-gear)"` is a valid theme-icon reference. `"icon": "$(settings-gear) Thinking Effort"` is not a valid icon-plus-label value: theme-icon parsing requires the complete string to match the icon syntax; an unmatched string is treated as an asset path. Keep human-readable text in `title`/`shortTitle`. [ThemeIcon parsing](https://github.com/microsoft/vscode/blob/49b24202921f02dc1215eb8db80d50ae239b3da7/src/vs/base/common/themables.ts#L65-L74), [command icon resolution](https://github.com/microsoft/vscode/blob/49b24202921f02dc1215eb8db80d50ae239b3da7/src/vs/workbench/services/actions/common/menusExtensionPoint.ts#L935-L943).

In the tested native toolbar presentation, the icon form used the command label as its tooltip, while the comparison text command omitted the icon and displayed **Effort: High**. Supplying an icon does not guarantee that the host will also render the title beside it; presentation is controlled by VS Code. [Menu action presentation](https://github.com/microsoft/vscode/blob/49b24202921f02dc1215eb8db80d50ae239b3da7/src/vs/platform/actions/browser/menuEntryActionViewItem.ts#L278-L286).

There is no supported setter to mutate a manifest-contributed command's title/icon at runtime. A finite set of predefined commands or submenus can be selected using `when` conditions and `setContext`, at the cost of extra manifest entries and state synchronization. A status bar item or extension-owned webview has directly mutable presentation. None of these approaches fixes the input toolbar's argument serialization.

## 9. Alternatives and why none completely meets the goal today

| Approach | What it provides | Main limitation for this user | Evidence level |
| --- | --- | --- | --- |
| Native per-model configuration schema | VS Code owns the effort UI and passes selected configuration to the provider. | Third-party hook remains proposed; a build-specific untyped workaround lacks a stable Marketplace contract. | Current declarations/converter inspected; not newly prototyped here. |
| Chat input gear → QuickPick | The user-preferred placement with a small native selection interaction. | Contributed command failed before its handler in the tested runtime. | Minimal live reproduction and debugger capture. |
| Chat header gear → submenu or QuickPick | A supported Chat-adjacent action that worked in the preview. | Worse proximity/current-value visibility; active-model and persistence semantics still require design. | Live preview verified. |
| Status bar → QuickPick | Supported action with dynamically updateable icon, text, and tooltip. | Uses already crowded bottom-screen space; not naturally scoped to a Chat/model. | Stable API and existing cost-item pattern; no effort-specific implementation. |
| Command Palette / optional keybinding → QuickPick | Small implementation, no permanent UI space, suitable for infrequent changes. | Less discoverable and no persistent on-screen indication of effort. | Palette invocation verified in the fixture. |
| Extension Settings UI | Persisted user/workspace preferences, without adding a toolbar item. | Away from Chat; per-model maps may need JSON or a custom command; changing settings does not automatically modify requests. | Available stable contribution mechanism; not implemented for effort. |
| Dedicated TreeView in a sidebar/view container | Native extension-controlled model rows and configuration commands. | A second model-management surface and layout cost for a small preference. | Supported alternative, not prototyped. |
| Webview view/panel or configuration section in the existing dashboard | Full dropdown/text layout and an explicit message channel to the extension. | Navigation/layout overhead; active Chat model association and request integration remain extension responsibilities. | Existing dashboard demonstrates the mechanism; effort UI not implemented. |
| Workbench HTML/CSS injection or Copilot/workbench patching | Potentially arbitrary placement/presentation. | Outside the supported extension boundary, coupled to host internals and distribution/update behavior. | Not implemented or verified. |

The supported surfaces are documented in [contribution points](https://code.visualstudio.com/api/references/contribution-points), [QuickPick guidance](https://code.visualstudio.com/api/ux-guidelines/quick-picks), [status bar guidance](https://code.visualstudio.com/api/ux-guidelines/status-bar), [TreeView API](https://code.visualstudio.com/api/extension-guides/tree-view), and [Webview API](https://code.visualstudio.com/api/extension-guides/webview).

**Most practical stable candidate:** the working Chat header action backed by a persisted extension preference and a Command Palette entry using the same handler. For this user's infrequent changes, it avoids a dedicated status bar item. This is a recommendation for further design, not a previously approved functional implementation. The native per-model hook would give a cleaner long-term integration once its contract is stable.

## 10. State delivery and provider integration still need implementation

With a native model configuration hook, VS Code carries the value in request options. With an extension-owned header/Palette/webview control, the command can persist the selected value through extension configuration or extension storage; the provider can read it when starting a request. No HTML interception is required for that communication. The difficulty is defining its scope and resolving the intended model, not communicating between the command and provider in the same extension.

A possible future flow is:

```text
header or Palette command
  -> choose model/default scope and a supported effort
  -> persist extension preference
  -> request starts: resolve and snapshot effective effort
  -> provider maps effort to backend payload
  -> UI/usage reporting identifies the effective model and configuration
```

Implementation decisions that remain open:

1. **Preference scope:** one global default, workspace default, per-provider/model defaults, or session override. The user rarely changes effort by session, but that does not settle all workspace/model semantics.
2. **Model association:** a header command cannot assume it knows the currently selected Chat model. A model-choice step or a labeled extension-wide default is safer than inferring from the active text editor or an undocumented context key.
3. **Default semantics:** decide whether Default means omission of backend parameters, a catalog default, or an extension default. Omission and explicit Medium/High are not interchangeable for every model.
4. **Allowed values:** the dummy five-item picker was not a capability matrix. The code recognizes Claude `xhigh` too; Grok and Gemini have different mappings. Verify each backend/model's currently supported controls before applying a universal enum.
5. **Precedence:** saved Workspace levels override User levels; otherwise use the named catalog default. Model identity and attribution remain independent.
6. **Request consistency:** snapshot the choice at request start so changing a setting does not alter an in-flight request. Decide whether non-Chat consumers such as commit-message generation inherit the same preference.
7. **Direct/proxy parity:** the same effective configuration must reach native requests routed through the proxy, while preserving the server's authoritative catalog and restrictions. A local UI value must not invent access to a backend model/effort combination.
8. **Backend correctness:** retain Claude signed thinking/tool-continuation replay; avoid applying a Gemini thinking-level field to a model requiring another control; validate Grok effort mapping against its supported route.
9. **Discovery:** maintain one reachability probe per resolved endpoint; effort choices are not separate reachability probes. Endpoint reachability is not proof that every possible effort value is accepted.
10. **Compatibility:** verify the declared VS Code engine floor as well as current Stable/Insiders and remote extension-host behavior. A location found in current main may not exist on the minimum version.

The current providers do not consume a new user-selected effort preference. A settings-only or UI-only change would therefore be incomplete as a functional feature.

## 11. Issues and fixes: avoid conflating different bugs

GitHub state was checked on 8 October 2026. A limited search of issue/PR titles and bodies containing `chat/input/status`, and Chat/circular-serialization terms, did not identify a report specifically tracking this exact toolbar reproduction. This does not prove no issue exists; references may occur only in comments or use other terminology. No upstream issue was filed during this work.

| Reference | Checked state | Relationship to this investigation |
| --- | --- | --- |
| [VS Code #322280](https://github.com/microsoft/vscode/issues/322280) | Closed/completed; milestone 1.126.0; verified label. | A real third-party model-configuration persistence/delivery bug. It is not an unresolved reason to reject the native hook today, and its closure does not graduate the proposed API. |
| [VS Code #265631](https://github.com/microsoft/vscode/issues/265631) | Closed/not planned on 11 December 2025. | Chat cancellation produced a related circular-serialization error. It is not a tracked fix for this status-toolbar command. |
| [VS Code #161294](https://github.com/microsoft/vscode/issues/161294) | Closed/completed in September 2022. | Historical contributed Ports-menu command failure with circular arguments; useful precedent, not confirmation that the Chat toolbar was fixed. |
| [VS Code PR #338857](https://github.com/microsoft/vscode/pull/338857) | Merged 30 September 2026; milestone 1.141.0. | Changed unexpected-error forwarding in `extensionHostMain.ts` to serialize the error. It did not change the Chat toolbar context or command-argument serializer. |

Do not treat the shared error text as proof that two reports have the same cause, or that an error-reporting fix resolves command argument delivery. There is no confirmed release target for the exact input-toolbar problem in the evidence collected here.

## 12. Recommended next investigation and acceptance criteria

For an agent resuming functional work, first confirm the intended scope and inspect current files rather than assuming the historical prototype exists. The latest user request was for this summary, not authorization to connect an effort picker to inference.

Once functional implementation is authorized:

1. Reproduce the isolated command test in current desktop Stable and Insiders, and record exact versions, extension-host location, and three-path outcomes. Check whether the forwarded argument still contains the internal widget.
2. Recheck stable/proposed API declarations and Marketplace guidance before deciding between native configuration and extension-owned preferences. Do not silently add proposal dependencies to the publishable extension.
3. Choose the state scope and precedence, then use the working header/Palette path as the small stable implementation candidate if the native hook remains unsuitable.
4. Connect the preference to provider request construction, using literal backend versions and the supported direct/proxy paths.
5. Verify actual backend payload configuration, not only picker rendering, command registration, or a changed label.

Meaningful acceptance checks include: a choice persists and is reapplied with the documented scope; canceling leaves it unchanged; unsupported combinations are handled deliberately; the named catalog default and saved preference precedence are unambiguous; the request contains the intended provider-specific fields; concurrent/in-flight requests keep their starting configuration; custom/proxy catalogs and commit-message consumers follow the documented semantics. Any live cloud tests should be reported separately from local/static checks.

All upstream source links in this handoff are pinned to a checked commit. Use their symbol names to locate moved code when reviewing another version. The live browser reproduction is historical evidence; current source checks and design recommendations are explicitly distinguished from newly tested behavior.
