# HVY

Open, read, edit, and refine `.hvy`, `.thvy`, and `.phvy` documents directly in Visual Studio Code.

HVY adds a rich custom editor for structured HVY files, including a polished reading view, visual editing tools, AI-assisted document editing, and quick access to the underlying HVY source when you need it.

## Features

- Editor and viewer for `.hvy`, `.thvy`, and `.phvy` documents
- AI mode for asking questions about the document and making assisted edits

## Opening HVY Files

Open any `.hvy`, `.thvy`, or `.phvy` file in VS Code. The HVY editor opens automatically as the default editor for those file types.

From the floating mode controls:

- `Viewer` shows the document as a reader-friendly preview.
- `AI` opens the document with AI-assisted reading and editing tools.
- `Editor` opens the visual document editor.
- `ADV` exposes advanced editing controls.
- `HVY` opens the same file in VS Code's regular text editor.

When viewing HVY source in the regular text editor, use the `HVY: Open Preview` button in the editor title bar to return to the rich HVY editor.

## AI Configuration

AI features are optional. Configure them in VS Code settings:

- `hvy.ai.provider`: `openai`, `anthropic`, or `qwen`
- `hvy.ai.model`: model used for HVY chat and edit requests
- `hvy.ai.apiKey`: provider API key
- `hvy.ai.openAiReasoningEffort`: reasoning effort for OpenAI requests

API requests are handled through the VS Code extension host, so API keys are not exposed to the webview.

## Editor Settings

- `hvy.editor.defaultMode`: choose the mode used when opening HVY files
- `hvy.editor.showModeControls`: show or hide the floating mode switcher

## Troubleshooting

If a document does not render as expected, run `HVY: Show Debug Output` from the Command Palette. The `HVY` output channel includes editor diagnostics and webview errors that can help identify malformed documents or configuration issues.
