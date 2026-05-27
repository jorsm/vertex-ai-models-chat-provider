# TODOs

[ ] Refactor Anthropic provider gigantic code into smaller methods
[ ] Refactor Repo structure to better manage the visual components of the extension

## 🧪 Future Testing Strategy

### Unit Tests (Logic Verification)
- **Cost Calculation**: Verify token-to-cost conversion logic in `UsageTrackerService` for all supported models (Gemini, Claude).
- **Message Mapping**: Validate that VS Code's `LanguageModelChatRequestMessage` is correctly transformed into Anthropic/Google native formats (especially image base64 and system instruction extraction).
- **GCP Label Sanitization**: Ensure user emails and project names are correctly sanitized to meet GCP label requirements.
- **Tool Schema Sanitization**: Verify that unsupported JSON Schema fields (like `markdownDescription`) are stripped before being sent to Vertex.

### Integration Tests (Environment Verification)
- **Extension Activation**: Confirm the extension loads and registers providers without crashing.
- **Usage Persistence**: Verify that `UsageTrackerService` correctly writes `.jsonl` files to the extension's global storage directory.
