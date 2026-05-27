import * as vscode from 'vscode';
import { HvyEditorProvider } from './hvyEditorProvider';

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('HVY');
  context.subscriptions.push(
    output,
    vscode.commands.registerCommand('hvy.showOutput', () => output.show()),
    vscode.commands.registerCommand('hvy.openPreview', async (uri?: vscode.Uri) => {
      const activeCustomEditorUri = getActiveHvyCustomEditorUri();
      if (activeCustomEditorUri) {
        await vscode.commands.executeCommand('vscode.openWith', activeCustomEditorUri, 'default');
        return;
      }

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

function getActiveHvyCustomEditorUri(): vscode.Uri | undefined {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  if (input instanceof vscode.TabInputCustom && input.viewType === HvyEditorProvider.viewType) {
    return input.uri;
  }
  return undefined;
}
