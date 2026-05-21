import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import * as vscode from 'vscode';
import { requestAiCompletion, type HvyChatRequest } from './providerClient';

type HvyExtension = '.hvy' | '.thvy';
type HvyViewMode = 'viewer' | 'ai' | 'editor' | 'advanced';

type WebviewMessage =
  | { type: 'ready' }
  | { type: 'dirty'; dirty?: boolean; mode?: HvyViewMode; reason?: string; source?: string; contentsBase64?: string }
  | { type: 'undoCommand' }
  | { type: 'redoCommand' }
  | { type: 'historyApplied'; requestId: string; contentsBase64: string }
  | { type: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; message: string }
  | { type: 'save'; requestId: string; contentsBase64: string }
  | { type: 'ai.complete'; requestId: string; request: HvyChatRequest; debugLabel?: string }
  | { type: 'ai.toolTurn'; requestId: string; request: HvyChatRequest; debugLabel?: string };

interface PendingSave {
  resolve(): void;
  reject(error: Error): void;
}

interface PendingHistoryOperation {
  resolve(): void;
  reject(error: Error): void;
}

class HvyDocument implements vscode.CustomDocument {
  private readonly disposeEmitter = new vscode.EventEmitter<void>();
  private pendingSaves = new Map<string, PendingSave>();
  private pendingHistoryOperations = new Map<string, PendingHistoryOperation>();
  private webviewPanel: vscode.WebviewPanel | undefined;
  private contents: Uint8Array;

  readonly onDidDispose = this.disposeEmitter.event;

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

  get contentsBase64(): string {
    return Buffer.from(this.contents).toString('base64');
  }

  updateContents(contentsBase64: string): void {
    this.contents = Buffer.from(contentsBase64, 'base64');
  }

  async restoreContents(contentsBase64: string): Promise<void> {
    this.updateContents(contentsBase64);
    await this.webviewPanel?.webview.postMessage({
      type: 'reloadDocument',
      contentsBase64,
      extension: this.extension,
    });
  }

  async applyHistoryOperation(operation: 'undo' | 'redo', fallbackContentsBase64: string): Promise<void> {
    if (!this.webviewPanel) {
      this.updateContents(fallbackContentsBase64);
      return;
    }

    const requestId = randomRequestId();
    const historyPromise = new Promise<void>((resolve, reject) => {
      this.pendingHistoryOperations.set(requestId, { resolve, reject });
    });
    const posted = await this.webviewPanel.webview.postMessage({ type: 'applyHistory', requestId, operation, fallbackContentsBase64 });
    if (!posted) {
      this.pendingHistoryOperations.delete(requestId);
      await this.restoreContents(fallbackContentsBase64);
      return;
    }
    await historyPromise;
  }

  async save(cancellation: vscode.CancellationToken): Promise<void> {
    if (!this.webviewPanel) {
      await vscode.workspace.fs.writeFile(this.uri, this.contents);
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
    this.updateContents(contentsBase64);
    vscode.workspace.fs.writeFile(this.uri, this.contents).then(
      () => {
        void this.webviewPanel?.webview.postMessage({ type: 'saved' });
        pending.resolve();
      },
      (error: unknown) => pending.reject(toError(error))
    );
  }

  completeHistoryOperation(requestId: string, contentsBase64: string): void {
    const pending = this.pendingHistoryOperations.get(requestId);
    if (!pending) {
      return;
    }
    this.pendingHistoryOperations.delete(requestId);
    this.updateContents(contentsBase64);
    pending.resolve();
  }

  dispose(): void {
    for (const pending of this.pendingSaves.values()) {
      pending.reject(new Error('HVY editor closed before save completed.'));
    }
    this.pendingSaves.clear();
    for (const pending of this.pendingHistoryOperations.values()) {
      pending.reject(new Error('HVY editor closed before history operation completed.'));
    }
    this.pendingHistoryOperations.clear();
    this.disposeEmitter.fire();
    this.disposeEmitter.dispose();
  }
}

export class HvyEditorProvider implements vscode.CustomEditorProvider<HvyDocument> {
  static readonly viewType = 'hvy.editor';

  private readonly changeDocumentEmitter = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<HvyDocument>>();
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
      if (message.dirty === false) {
        this.log('debug', `Document clean signal for ${document.uri.fsPath}${message.reason ? ` reason=${message.reason}` : ''}`);
        return;
      }
      if (message.mode === 'viewer') {
        this.log('debug', `Ignoring viewer-mode dirty signal for ${document.uri.fsPath}${message.reason ? ` (${message.reason})` : ''}`);
        return;
      }
      this.log('debug', `Accepting dirty signal for ${document.uri.fsPath}${message.mode ? ` mode=${message.mode}` : ''}${message.reason ? ` reason=${message.reason}` : ''}${message.source ? ` source=${message.source}` : ''}`);
      if (!message.contentsBase64) {
        this.log('warn', `Ignoring dirty signal without serialized contents for ${document.uri.fsPath}`);
        return;
      }
      this.fireDocumentEdit(document, message.contentsBase64, message.reason, message.source);
      return;
    }

    if (message.type === 'undoCommand' || message.type === 'redoCommand') {
      await vscode.commands.executeCommand(message.type === 'undoCommand' ? 'undo' : 'redo');
      return;
    }

    if (message.type === 'historyApplied') {
      document.completeHistoryOperation(message.requestId, message.contentsBase64);
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

  private fireDocumentEdit(document: HvyDocument, contentsBase64: string, reason?: string, source?: string): void {
    const before = document.contentsBase64;
    const after = contentsBase64;
    if (before === after) {
      this.log('debug', `Ignoring unchanged edit signal for ${document.uri.fsPath}${reason ? ` reason=${reason}` : ''}`);
      return;
    }
    document.updateContents(after);
    this.changeDocumentEmitter.fire({
      document,
      label: formatEditLabel(reason, source),
      undo: () => document.applyHistoryOperation('undo', before),
      redo: () => document.applyHistoryOperation('redo', after),
    });
  }

  private renderHtml(webview: vscode.Webview, embedRoot: string, document: HvyDocument): string {
    const nonce = randomNonce();
    const embedPath = resolveHvyEmbedEntrypoint(embedRoot);
    const embedUri = withCacheBust(webview.asWebviewUri(vscode.Uri.file(embedPath)), getFileVersion(embedPath));
    const stylesheetLinks = resolveEmbedStylesheets(embedRoot)
      .map((stylesheetPath) => {
        const uri = withCacheBust(webview.asWebviewUri(vscode.Uri.file(stylesheetPath)), getFileVersion(stylesheetPath));
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
    body.hvy-vscode-has-mode-controls .viewer-shell .reader-document {
      padding-top: 44px;
    }
    body.hvy-vscode-has-mode-controls .editor-shell .editor-tree {
      padding-top: max(2rem, 44px);
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
    .hvy-vscode-mode-controls {
      position: fixed;
      top: 10px;
      right: 14px;
      z-index: 10000;
      display: inline-flex;
      align-items: flex-start;
      gap: 3px;
      border: 1px solid var(--vscode-widget-border, transparent);
      border-radius: 8px;
      background: color-mix(in srgb, var(--vscode-editorWidget-background) 88%, transparent);
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.22);
      backdrop-filter: blur(10px);
    }
    .hvy-vscode-mode-top {
      display: inline-flex;
      align-items: center;
      gap: 3px;
      padding: 3px;
    }
    .hvy-vscode-editor-stack {
      position: relative;
      display: inline-flex;
      flex-direction: column;
      align-items: stretch;
      gap: 3px;
    }
    .hvy-vscode-mode-button {
      min-width: 32px;
      height: 30px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 5px;
      padding: 0 7px;
      border: 1px solid transparent;
      border-radius: 6px;
      color: var(--vscode-icon-foreground);
      background: transparent;
      font: 600 11px var(--vscode-font-family);
      cursor: pointer;
    }
    .hvy-vscode-mode-button[data-hvy-vscode-mode="advanced"] {
      position: absolute;
      top: calc(100% + 3px);
      left: 0;
      right: 0;
      width: 100%;
      min-width: 0;
      height: 24px;
      padding: 0 3px;
      font-size: 10px;
      letter-spacing: 0;
      color: var(--vscode-icon-foreground);
      background: color-mix(in srgb, var(--vscode-editorWidget-background) 96%, var(--vscode-toolbar-hoverBackground) 4%);
      box-shadow: 0 4px 14px rgba(0, 0, 0, 0.18);
    }
    .hvy-vscode-mode-button[data-hvy-vscode-mode="advanced"] span {
      display: inline;
    }
    .hvy-vscode-mode-button svg {
      width: 15px;
      height: 15px;
      fill: none;
      stroke: currentColor;
      stroke-width: 2;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    .hvy-vscode-mode-button:hover {
      background: var(--vscode-toolbar-hoverBackground);
    }
    .hvy-vscode-mode-button.is-active {
      border-color: var(--vscode-focusBorder);
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
    }
    @media (max-width: 700px) {
      .hvy-vscode-mode-button:not([data-hvy-vscode-mode="advanced"]) span {
        display: none;
      }
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
      defaultMode: ${JSON.stringify(getDefaultViewMode())},
      showModeControls: ${JSON.stringify(getShowModeControls())}
    };
  </script>
  <script nonce="${nonce}" type="module">
    const vscode = acquireVsCodeApi();
    const root = document.getElementById('root');
    const bootError = document.getElementById('boot-error');
    const bootStatus = document.getElementById('boot-status');
    const pendingAi = new Map();
    let mount = null;
    let currentMode = 'viewer';
    let currentContentsBase64 = window.HVY_VSCODE_BOOT.contentsBase64;
    let applyingVsCodeHistory = false;

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

    function isNativeUndoTarget(target) {
      if (!(target instanceof HTMLElement)) {
        return false;
      }
      if (target.closest('.theme-modal')) {
        return false;
      }
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) {
        return true;
      }
      return target.isContentEditable;
    }

    window.addEventListener('keydown', (event) => {
      if (event.defaultPrevented || isNativeUndoTarget(event.target)) {
        return;
      }
      const meta = event.metaKey || event.ctrlKey;
      if (!meta) {
        return;
      }
      const key = event.key.toLowerCase();
      const isUndo = key === 'z' && !event.shiftKey;
      const isRedo = key === 'y' || (key === 'z' && event.shiftKey);
      if (!isUndo && !isRedo) {
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      vscode.postMessage({ type: isUndo ? 'undoCommand' : 'redoCommand' });
    }, { capture: true });

    function svgIcon(name) {
      const icons = {
        viewer: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6Z"/><circle cx="12" cy="12" r="2.5"/></svg>',
        ai: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l1.5 5.5L19 10l-5.5 1.5L12 17l-1.5-5.5L5 10l5.5-1.5L12 3Z"/><path d="M19 15l.7 2.3L22 18l-2.3.7L19 21l-.7-2.3L16 18l2.3-.7L19 15Z"/></svg>',
        editor: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5Z"/></svg>'
      };
      return icons[name] || '';
    }

    function renderModeControls() {
      if (!window.HVY_VSCODE_BOOT.showModeControls) {
        document.body.classList.remove('hvy-vscode-has-mode-controls');
        return;
      }
      document.body.classList.add('hvy-vscode-has-mode-controls');
      let controls = document.querySelector('.hvy-vscode-mode-controls');
      if (!controls) {
        controls = document.createElement('nav');
        controls.className = 'hvy-vscode-mode-controls';
        controls.setAttribute('aria-label', 'HVY editor mode');
        document.body.appendChild(controls);
      }
      controls.classList.toggle('is-editor-enabled', currentMode === 'editor' || currentMode === 'advanced');
      const buttonHtml = (mode) => {
        const label = mode === 'ai' ? 'AI' : mode === 'advanced' ? 'ADV' : mode[0].toUpperCase() + mode.slice(1);
        const active = mode === currentMode ? ' is-active' : '';
        const contents = mode === 'advanced' ? '<span>ADV</span>' : svgIcon(mode) + '<span>' + label + '</span>';
        return '<button type="button" class="hvy-vscode-mode-button' + active + '" data-hvy-vscode-mode="' + mode + '" title="' + label + '" aria-label="' + label + '">' + contents + '</button>';
      };
      const showAdvanced = currentMode === 'editor' || currentMode === 'advanced';
      controls.innerHTML = '<div class="hvy-vscode-mode-top">'
        + buttonHtml('viewer')
        + buttonHtml('ai')
        + '<span class="hvy-vscode-editor-stack">'
        + buttonHtml('editor')
        + (showAdvanced ? buttonHtml('advanced') : '')
        + '</span>'
        + '</div>';
      controls.querySelectorAll('button').forEach((button) => {
        button.addEventListener('click', async () => {
          const mode = button.dataset.hvyVscodeMode;
          if (mode && mode !== currentMode) {
            await switchMode(mode);
          }
        });
      });
    }

    async function switchMode(mode) {
      if (!window.HVY_VSCODE_MODULE || !mount) {
        return;
      }
      try {
        currentContentsBase64 = bytesToBase64(mount.serializeDocumentBytes());
        await loadDocument(window.HVY_VSCODE_MODULE, currentContentsBase64, window.HVY_VSCODE_BOOT.extension, mode);
      } catch (error) {
        showError(error);
      }
    }

    async function loadDocument(HVY, contentsBase64, extension, mode) {
      mount?.destroy();
      root.textContent = '';
      const documentBytes = base64ToBytes(contentsBase64);
      currentMode = mode === 'advanced' ? 'advanced' : mode;
      log('info', 'Mounting HVY document', { extension, mode: currentMode, bytes: documentBytes.byteLength });
      mount = HVY.mountHvy({
        root,
        document: HVY.deserializeDocumentBytes(documentBytes, extension),
        mode: mode === 'advanced' ? 'editor' : mode,
        showAdvancedEditor: mode === 'advanced',
        chatClient,
        storageKey: null,
        onDocumentChange(event) {
          currentContentsBase64 = bytesToBase64(mount.serializeDocumentBytes());
          log('debug', 'Document change hook', { mode: currentMode, dirty: event?.dirty, reason: event?.reason, source: event?.source });
          if (applyingVsCodeHistory) {
            return;
          }
          vscode.postMessage({
            type: 'dirty',
            dirty: event?.dirty,
            mode: currentMode,
            reason: event?.reason,
            source: event?.source,
            contentsBase64: currentContentsBase64
          });
        }
      });
      currentContentsBase64 = bytesToBase64(mount.serializeDocumentBytes());
      renderModeControls();
      bootStatus.hidden = true;
      log('info', 'Mounted HVY document', { childCount: root.childElementCount });
    }

    try {
      const boot = window.HVY_VSCODE_BOOT;
      log('info', 'Importing HVY embed bundle', boot.embedUri);
      const importedHvy = await import(boot.embedUri);
      const HVY = importedHvy.deserializeDocumentBytes
        ? importedHvy
        : importedHvy.e?.deserializeDocumentBytes
          ? importedHvy.e
          : window.HVY;
      if (!HVY?.deserializeDocumentBytes || !HVY?.mountHvy) {
        throw new Error('HVY embed bundle did not expose the expected mount/serialization API.');
      }
      window.HVY_VSCODE_MODULE = HVY;
      log('info', 'Imported HVY embed bundle', Object.keys(HVY));
      await loadDocument(HVY, boot.contentsBase64, boot.extension, boot.defaultMode);

      window.addEventListener('message', async (event) => {
        const message = event.data;
        if (message?.type === 'collectForSave') {
          currentContentsBase64 = bytesToBase64(mount.serializeDocumentBytes());
          vscode.postMessage({
            type: 'save',
            requestId: message.requestId,
            contentsBase64: currentContentsBase64
          });
          return;
        }
        if (message?.type === 'applyHistory') {
          applyingVsCodeHistory = true;
          try {
            try {
              if (message.operation === 'undo' && typeof mount?.undo === 'function') {
                mount.undo();
              } else if (message.operation === 'redo' && typeof mount?.redo === 'function') {
                mount.redo();
              } else {
                await loadDocument(HVY, message.fallbackContentsBase64, window.HVY_VSCODE_BOOT.extension, currentMode);
              }
            } catch (error) {
              log('warn', 'HVY mount history operation failed; restoring serialized fallback.', error);
              await loadDocument(HVY, message.fallbackContentsBase64, window.HVY_VSCODE_BOOT.extension, currentMode);
            }
            currentContentsBase64 = bytesToBase64(mount.serializeDocumentBytes());
          } finally {
            applyingVsCodeHistory = false;
          }
          vscode.postMessage({
            type: 'historyApplied',
            requestId: message.requestId,
            contentsBase64: currentContentsBase64
          });
          return;
        }
        if (message?.type === 'saved') {
          mount?.markSaved?.();
          return;
        }
        if (message?.type === 'reloadDocument') {
          currentContentsBase64 = message.contentsBase64;
          await loadDocument(HVY, message.contentsBase64, message.extension, currentMode);
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
  candidates.push(path.join(extensionUri.fsPath, 'vendor', 'heavy-file-format', 'dist-embed'));
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

function resolveHvyEmbedEntrypoint(embedRoot: string): string {
  const assetsRoot = path.join(embedRoot, 'assets');
  try {
    const fullEmbed = fs.readdirSync(assetsRoot)
      .filter((fileName) => /^embed-full-.*\.js$/.test(fileName))
      .sort()
      .at(-1);
    if (fullEmbed) {
      return path.join(assetsRoot, fullEmbed);
    }
  } catch {
    // Fall back to the public lightweight entry below.
  }
  return path.join(embedRoot, 'hvy-embed.js');
}

function getFileVersion(filePath: string): string {
  try {
    return String(Math.floor(fs.statSync(filePath).mtimeMs));
  } catch {
    return String(Date.now());
  }
}

function withCacheBust(uri: vscode.Uri, version: string): vscode.Uri {
  return uri.with({
    query: [uri.query, `v=${encodeURIComponent(version)}`].filter(Boolean).join('&'),
  });
}

function getDefaultViewMode(): HvyViewMode {
  const configured = vscode.workspace.getConfiguration('hvy.editor').get<string>('defaultMode');
  return configured === 'ai' || configured === 'editor' || configured === 'advanced' ? configured : 'viewer';
}

function getShowModeControls(): boolean {
  return vscode.workspace.getConfiguration('hvy.editor').get<boolean>('showModeControls') !== false;
}

function formatEditLabel(reason?: string, source?: string): string {
  const label = reason || source;
  if (!label) {
    return 'Edit HVY document';
  }
  return `Edit HVY document (${label})`;
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
