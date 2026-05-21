# HVY VS Code Extension

VS Code custom editor for `.hvy` and `.thvy` files, powered by the
`heavy-file-format` reference implementation.

## Development

Expected checkout layout:

```text
heavy-file-format/
hvy-vs-code-extension/
```

Build the HVY embed bundle first:

```bash
cd ../heavy-file-format
npm install
npm run build:embed
```

Then install and compile the extension:

```bash
cd ../hvy-vs-code-extension
npm install
npm run compile
```

The extension depends on the local sibling checkout by default:

```json
"heavy-file-format-ref-impl": "file:../heavy-file-format"
```

Launch `Run HVY Extension` from VS Code and open a `.hvy` or `.thvy` file.

This repo includes a sample file for smoke testing:

```text
examples/resume.hvy
```

## Local VSIX Install

To install the extension into your regular VS Code windows from this checkout:

```bash
npm run install:local
```

That switches the extension back to the sibling `../heavy-file-format`
dependency, installs dependencies, copies the built embed assets into
`vendor/heavy-file-format`, compiles, packages `hvy-local.vsix`, and installs it
with `code --install-extension --force`.

If you only want to build the local VSIX:

```bash
npm run package:local
```

After reinstalling, reload any already-open VS Code windows before opening
`.hvy` or `.thvy` files.

## Testing In VS Code

1. Build the sibling HVY embed bundle:
   ```bash
   cd ../heavy-file-format
   npm install
   npm run build:embed
   ```
2. Build this extension:
   ```bash
   cd ../hvy-vs-code-extension
   npm install
   npm run compile
   ```
3. Open this repo in VS Code.
4. Run the `Run HVY Extension` launch config.
5. In the Extension Development Host window, open `examples/resume.hvy`.
6. Make an edit, save, and confirm the file updates without errors.

If the editor appears blank, run `HVY: Show Debug Output` from the Command
Palette in the Extension Development Host window. The `HVY` output channel
includes extension-host messages and forwarded webview boot errors.

## AI Settings

AI requests are bridged through the VS Code extension host, so API keys do not
enter the webview bundle. Configure:

- `hvy.ai.provider`: `openai`, `anthropic`, or `qwen`
- `hvy.ai.model`
- `hvy.ai.apiKey`
- `hvy.ai.openAiReasoningEffort` for OpenAI requests

Editor settings:

- `hvy.editor.defaultMode`: `viewer`, `ai`, `editor`, or `advanced`
- `hvy.editor.showModeControls`: show or hide the top-right mode switcher

## Release Dependency

For release packaging, switch the dependency to the pinned git ref:

```bash
npm run use:hvy-git
npm install
npm run compile
```

That writes:

```json
"heavy-file-format-ref-impl": "git+https://github.com/heavy-resume/heavy-file-format.git#v0.1.0"
```

Use `npm run use:hvy-local` to return to the local development dependency.

## Extension Icon

The extension icon is configured with:

```json
"icon": "media/icon.png"
```

VS Code Marketplace expects a square PNG, commonly 128x128 or larger. The
current icon is copied from the Heavy Resume assets and can be replaced by
putting a new PNG at `media/icon.png`.

VS Code does not support extensions patching a single file icon into the active
file icon theme. The extension icon is used for marketplace/extension listings;
`.hvy` and `.thvy` files keep whatever icon the user's active file icon theme
chooses for those extensions or language IDs.
