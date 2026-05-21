import * as vscode from 'vscode';
import { HvyEditorProvider } from './hvyEditorProvider';

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('HVY');
  context.subscriptions.push(
    output,
    vscode.commands.registerCommand('hvy.showOutput', () => output.show()),
    vscode.commands.registerCommand('hvy.openPreview', async (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!target) {
        return;
      }
      await vscode.commands.executeCommand('vscode.openWith', target, HvyEditorProvider.viewType);
    }),
    vscode.window.registerCustomEditorProvider(
      HvyEditorProvider.viewType,
      new HvyEditorProvider(context, output),
      {
        webviewOptions: {
          retainContextWhenHidden: true,
        },
        supportsMultipleEditorsPerDocument: false,
      }
    )
  );
}

export function deactivate(): void {
  // No global resources to dispose.
}
