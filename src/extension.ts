import * as vscode from 'vscode';
import { HvyEditorProvider } from './hvyEditorProvider';

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('HVY');
  context.subscriptions.push(
    output,
    vscode.commands.registerCommand('hvy.showOutput', () => output.show()),
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
