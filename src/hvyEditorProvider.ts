import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import * as vscode from 'vscode';
import { requestAiCompletion, type HvyChatRequest } from './providerClient';

type HvyExtension = '.hvy' | '.thvy';

type WebviewMessage =
  | { type: 'ready' }
  | { type: 'dirty' }
  | { type: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; message: string }
  | { type: 'save'; requestId: string; contentsBase64: string }
  | { type: 'ai.complete'; requestId: string; request: HvyChatRequest; debugLabel?: string }
  | { type: 'ai.toolTurn'; requestId: string; request: HvyChatRequest; debugLabel?: string };

interface PendingSave {
  resolve(): void;
  reject(error: Error): void;
}

class HvyDocument implements vscode.CustomDocument {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  private readonly disposeEmitter = new vscode.EventEmitter<void>();
  private pendingSaves = new Map<string, PendingSave>();
  private webviewPanel: vscode.WebviewPanel | undefined;
  private contents: Uint8Array;
  private dirty = false;

  readonly onDidDispose = this.disposeEmitter.event;
  readonly onDidChange = this.changeEmitter.event;

  private constructor(
    readonly uri: vscode.Uri,
    contents: Uint8Array
  ) {
    this.contents = contents;
  }

  static async create(uri: vscode.Uri): Promise<HvyDocument> {
    return new HvyDocument(uri, await vscode.workspace.fs.readFile(uri));
  }

  get extension(): HvyExtension {
    return path.extname(this.uri.path).toLowerCase() === '.thvy' ? '.thvy' : '.hvy';
  }

  get initialContentsBase64(): string {
    return Buffer.from(this.contents).toString('base64');
  }

  attachPanel(panel: vscode.WebviewPanel): void {
    this.webviewPanel = panel;
  }

  markDirty(): void {
    if (!this.dirty) {
      this.dirty = true;
      this.changeEmitter.fire();
    }
  }

  async save(cancellation: vscode.CancellationToken): Promise<void> {
    if (!this.webviewPanel) {
      await vscode.workspace.fs.writeFile(this.uri, this.contents);
      this.dirty = false;
      return;
    }

    const requestId = randomRequestId();
    const savePromise = new Promise<void>((resolve, reject) => {
      this.pendingSaves.set(requestId, { resolve, reject });
    });
    await this.webviewPanel.webview.postMessage({ type: 'collectForSave', requestId });
    await raceCancellation(savePromise, cancellation);
  }

  async saveAs(targetResource: vscode.Uri, cancellation: vscode.CancellationToken): Promise<void> {
    await this.save(cancellation);
    await vscode.workspace.fs.writeFile(targetResource, this.contents);
  }

  async revert(): Promise<void> {
    const contents = await vscode.workspace.fs.readFile(this.uri);
    this.contents = contents;
    this.dirty = false;
    void this.webviewPanel?.webview.postMessage({
      type: 'reloadDocument',
      contentsBase64: Buffer.from(contents).toString('base64'),
      extension: this.extension,
    });
  }

  async backup(destination: vscode.Uri): Promise<vscode.CustomDocumentBackup> {
    await vscode.workspace.fs.writeFile(destination, this.contents);
    return {
      id: destination.toString(),
      delete: () => vscode.workspace.fs.delete(destination).then(undefined, undefined),
    };
  }

  completeSave(requestId: string, contentsBase64: string): void {
    const pending = this.pendingSaves.get(requestId);
    if (!pending) {
      return;
    }
    this.pendingSaves.delete(requestId);
    this.contents = Buffer.from(contentsBase64, 'base64');
    vscode.workspace.fs.writeFile(this.uri, this.contents).then(
      () => {
        this.dirty = false;
        pending.resolve();
      },
      (error: unknown) => pending.reject(toError(error))
    );
  }

  dispose(): void {
    for (const pending of this.pendingSaves.values()) {
      pending.reject(new Error('HVY editor closed before save completed.'));
    }
    this.pendingSaves.clear();
    this.changeEmitter.dispose();
    this.disposeEmitter.fire();
    this.disposeEmitter.dispose();
  }
}

export class HvyEditorProvider implements vscode.CustomEditorProvider<HvyDocument> {
  static readonly viewType = 'hvy.editor';

  private readonly changeDocumentEmitter = new vscode.EventEmitter<vscode.CustomDocumentContentChangeEvent<HvyDocument>>();
  readonly onDidChangeCustomDocument = this.changeDocumentEmitter.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel
  ) {}

  openCustomDocument(uri: vscode.Uri): Promise<HvyDocument> {
    return HvyDocument.create(uri);
  }

  async resolveCustomEditor(document: HvyDocument, webviewPanel: vscode.WebviewPanel): Promise<void> {
    const embedRoot = resolveHvyEmbedRoot(this.context.extensionUri);
    this.log('info', `Opening ${document.uri.fsPath}`);
    this.log('info', `Using HVY embed bundle from ${embedRoot}`);
    document.attachPanel(webviewPanel);

    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        this.context.extensionUri,
        vscode.Uri.file(embedRoot),
      ],
    };

    webviewPanel.webview.html = this.renderHtml(webviewPanel.webview, embedRoot, document);

    webviewPanel.webview.onDidReceiveMessage(
      (message: WebviewMessage) => this.handleMessage(document, webviewPanel.webview, message),
      undefined,
      this.context.subscriptions
    );
  }

  saveCustomDocument(document: HvyDocument, cancellation: vscode.CancellationToken): Promise<void> {
    return document.save(cancellation);
  }

  saveCustomDocumentAs(document: HvyDocument, destination: vscode.Uri, cancellation: vscode.CancellationToken): Promise<void> {
    return document.saveAs(destination, cancellation);
  }

  revertCustomDocument(document: HvyDocument, _cancellation: vscode.CancellationToken): Promise<void> {
    return document.revert();
  }

  backupCustomDocument(document: HvyDocument, context: vscode.CustomDocumentBackupContext, _cancellation: vscode.CancellationToken): Promise<vscode.CustomDocumentBackup> {
    return document.backup(context.destination);
  }

  private async handleMessage(document: HvyDocument, webview: vscode.Webview, message: WebviewMessage): Promise<void> {
    if (!message || typeof message.type !== 'string') {
      return;
    }

    if (message.type === 'ready') {
      this.log('info', `Webview ready for ${document.uri.fsPath}`);
      return;
    }

    if (message.type === 'log') {
      this.log(message.level, message.message);
      return;
    }

    if (message.type === 'dirty') {
      document.markDirty();
      this.changeDocumentEmitter.fire({ document });
      return;
    }

    if (message.type === 'save') {
      document.completeSave(message.requestId, message.contentsBase64);
      return;
    }

    if (message.type === 'ai.complete' || message.type === 'ai.toolTurn') {
      try {
        const response = await requestAiCompletion(message.request, {
          toolTurn: message.type === 'ai.toolTurn',
          debugLabel: message.debugLabel,
        });
        await webview.postMessage({ type: 'ai.response', requestId: message.requestId, response });
      } catch (error) {
        await webview.postMessage({ type: 'ai.error', requestId: message.requestId, error: toError(error).message });
      }
    }
  }

  private log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
    const stamp = new Date().toISOString();
    this.output.appendLine(`[${stamp}] [${level}] ${message}`);
  }

  private renderHtml(webview: vscode.Webview, embedRoot: string, document: HvyDocument): string {
    const nonce = randomNonce();
    const embedUri = webview.asWebviewUri(vscode.Uri.file(path.join(embedRoot, 'hvy-embed.js')));
    const stylesheetLinks = resolveEmbedStylesheets(embedRoot)
      .map((stylesheetPath) => {
        const uri = webview.asWebviewUri(vscode.Uri.file(stylesheetPath));
        return `<link rel="stylesheet" href="${escapeHtml(String(uri))}">`;
      })
      .join('\n  ');
    const csp = [
      "default-src 'none'",
      `script-src 'nonce-${nonce}' ${webview.cspSource}`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `img-src ${webview.cspSource} data: blob:`,
      `font-src ${webview.cspSource}`,
      `connect-src ${webview.cspSource}`,
      `worker-src ${webview.cspSource} blob:`,
    ].join('; ');

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp)}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>HVY Editor</title>
  ${stylesheetLinks}
  <style>
    html, body, #root {
      width: 100%;
      height: 100%;
      margin: 0;
      padding: 0;
      overflow: hidden;
    }
    body {
      background: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      font-family: var(--vscode-font-family);
    }
    #root {
      overflow: auto;
    }
    #boot-error {
      box-sizing: border-box;
      padding: 16px;
      white-space: pre-wrap;
    }
    #boot-status {
      box-sizing: border-box;
      padding: 16px;
      color: var(--vscode-descriptionForeground);
    }
  </style>
</head>
<body>
  <div id="boot-status">Loading HVY editor...</div>
  <div id="root"></div>
  <div id="boot-error" hidden></div>
  <script nonce="${nonce}">
    window.HVY_VSCODE_BOOT = {
      embedUri: ${JSON.stringify(String(embedUri))},
      contentsBase64: ${JSON.stringify(document.initialContentsBase64)},
      extension: ${JSON.stringify(document.extension)},
      documentKey: ${JSON.stringify(document.uri.toString())}
    };
  </script>
  <script nonce="${nonce}" type="module">
    const vscode = acquireVsCodeApi();
    const root = document.getElementById('root');
    const bootError = document.getElementById('boot-error');
    const bootStatus = document.getElementById('boot-status');
    const pendingAi = new Map();
    let mount = null;
    let suppressDirty = false;

    function formatLogPart(part) {
      if (part instanceof Error) {
        return part.stack || part.message;
      }
      if (typeof part === 'string') {
        return part;
      }
      try {
        return JSON.stringify(part);
      } catch {
        return String(part);
      }
    }

    function log(level, ...parts) {
      vscode.postMessage({ type: 'log', level, message: parts.map(formatLogPart).join(' ') });
    }

    for (const level of ['debug', 'info', 'warn', 'error']) {
      const original = console[level].bind(console);
      console[level] = (...parts) => {
        original(...parts);
        log(level, ...parts);
      };
    }

    window.addEventListener('error', (event) => {
      log('error', event.error || event.message);
    });

    window.addEventListener('unhandledrejection', (event) => {
      log('error', event.reason || 'Unhandled promise rejection');
    });

    function showError(error) {
      bootStatus.hidden = true;
      bootError.hidden = false;
      bootError.textContent = error && error.stack ? error.stack : String(error);
      log('error', error);
    }

    function base64ToBytes(base64) {
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }
      return bytes;
    }

    function bytesToBase64(bytes) {
      let binary = '';
      const chunkSize = 0x8000;
      for (let index = 0; index < bytes.length; index += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
      }
      return btoa(binary);
    }

    function postAi(type, request, options = {}) {
      const requestId = crypto.randomUUID();
      vscode.postMessage({ type, requestId, request, debugLabel: options.debugLabel });
      return new Promise((resolve, reject) => {
        pendingAi.set(requestId, { resolve, reject });
      });
    }

    const chatClient = {
      complete(request, options = {}) {
        return postAi('ai.complete', request, options);
      },
      toolTurn(request, options = {}) {
        return postAi('ai.toolTurn', request, options);
      }
    };

    async function loadDocument(HVY, contentsBase64, extension, documentKey) {
      suppressDirty = true;
      mount?.destroy();
      root.textContent = '';
      const documentBytes = base64ToBytes(contentsBase64);
      log('info', 'Mounting HVY document', { extension, bytes: documentBytes.byteLength });
      mount = HVY.mountHvy({
        root,
        document: HVY.deserializeDocumentBytes(documentBytes, extension),
        mode: 'ai',
        chatClient,
        storageKey: 'vscode:' + documentKey
      });
      bootStatus.hidden = true;
      log('info', 'Mounted HVY document', { childCount: root.childElementCount });
      queueMicrotask(() => {
        suppressDirty = false;
      });
    }

    try {
      const boot = window.HVY_VSCODE_BOOT;
      log('info', 'Importing HVY embed bundle', boot.embedUri);
      const HVY = await import(boot.embedUri);
      log('info', 'Imported HVY embed bundle', Object.keys(HVY));
      await loadDocument(HVY, boot.contentsBase64, boot.extension, boot.documentKey);

      const observer = new MutationObserver(() => {
        if (!suppressDirty && mount) {
          vscode.postMessage({ type: 'dirty' });
        }
      });
      observer.observe(root, { subtree: true, childList: true, attributes: true, characterData: true });

      window.addEventListener('message', async (event) => {
        const message = event.data;
        if (message?.type === 'collectForSave') {
          vscode.postMessage({
            type: 'save',
            requestId: message.requestId,
            contentsBase64: bytesToBase64(mount.serializeDocumentBytes())
          });
          return;
        }
        if (message?.type === 'reloadDocument') {
          await loadDocument(HVY, message.contentsBase64, message.extension, boot.documentKey);
          return;
        }
        if (message?.type === 'ai.response' || message?.type === 'ai.error') {
          const pending = pendingAi.get(message.requestId);
          if (!pending) {
            return;
          }
          pendingAi.delete(message.requestId);
          if (message.type === 'ai.error') {
            pending.reject(new Error(message.error || 'HVY AI request failed.'));
          } else {
            pending.resolve(message.response);
          }
        }
      });

      vscode.postMessage({ type: 'ready' });
    } catch (error) {
      showError(error);
    }
  </script>
</body>
</html>`;
  }
}

function resolveHvyEmbedRoot(extensionUri: vscode.Uri): string {
  const requireFromExtension = createRequire(path.join(extensionUri.fsPath, 'package.json'));
  const candidates: string[] = [];
  try {
    candidates.push(path.join(path.dirname(requireFromExtension.resolve('heavy-file-format-ref-impl/package.json')), 'dist-embed'));
  } catch {
    // npm install has not necessarily run during early local development.
  }
  candidates.push(path.resolve(extensionUri.fsPath, '..', 'heavy-file-format', 'dist-embed'));

  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'hvy-embed.js'))) {
      return candidate;
    }
  }

  throw new Error('Unable to find heavy-file-format dist-embed/hvy-embed.js. Run npm install here and npm run build:embed in ../heavy-file-format.');
}

function resolveEmbedStylesheets(embedRoot: string): string[] {
  const assetsRoot = path.join(embedRoot, 'assets');
  try {
    return fs.readdirSync(assetsRoot)
      .filter((fileName) => fileName.endsWith('.css'))
      .map((fileName) => path.join(assetsRoot, fileName));
  } catch {
    return [];
  }
}

function randomRequestId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function randomNonce(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let index = 0; index < 32; index += 1) {
    text += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return text;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      default: return '&#39;';
    }
  });
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

async function raceCancellation<T>(promise: Promise<T>, cancellation: vscode.CancellationToken): Promise<T> {
  if (!cancellation.isCancellationRequested) {
    return new Promise<T>((resolve, reject) => {
      const disposable = cancellation.onCancellationRequested(() => {
        disposable.dispose();
        reject(new vscode.CancellationError());
      });
      promise.then(
        (value) => {
          disposable.dispose();
          resolve(value);
        },
        (error: unknown) => {
          disposable.dispose();
          reject(error);
        }
      );
    });
  }
  throw new vscode.CancellationError();
}
