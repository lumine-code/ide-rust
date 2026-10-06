const { serverContext } = require("./server-resolver");
const childProcess = require("node:child_process");
const path = require("node:path");
const { configurationContext, workspaceConfiguration } = require(
  path.join(lumine.packages.resolvePackagePath("ide-client"), "lib", "workspace-configuration"),
);
const { pathToFileURL, fileURLToPath } = require("node:url");
const {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} = require("vscode-jsonrpc/node");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const withTimeout = (promise, label, timeout = 30000) => {
  let timer;
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeout}ms`)), timeout);
    }),
  ]).finally(() => clearTimeout(timer));
};

class LiveLspClient {
  constructor(adapter, rootPath) {
    this.adapter = adapter;
    this.rootPath = rootPath;
    this.notifications = [];
    this.documents = new Map();
    this.stderr = "";
  }
  configurationContext() {
    return configurationContext(this.rootPath, this.launch, this.session, serverContext().resolver);
  }

  configuration(items) {
    return workspaceConfiguration(this.adapter, items, this.configurationContext());
  }

  async start() {
    const launch = await this.adapter.resolveServer(serverContext({ rootPath: this.rootPath }));
    this.launch = launch;
    if (!launch) throw new Error("No working rust-analyzer was found for the live specs.");
    this.child = childProcess.spawn(launch.command, launch.args || [], {
      cwd: launch.cwd || this.rootPath,
      env: { ...process.env, ...(launch.env || {}) },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stderr.on("data", (chunk) => (this.stderr += chunk.toString()));
    this.connection = createMessageConnection(
      new StreamMessageReader(this.child.stdout),
      new StreamMessageWriter(this.child.stdin),
      { error: (message) => (this.stderr += `${message}\n`), warn() {}, info() {}, log() {} },
    );
    this.connection.onNotification((method, params) => this.notifications.push({ method, params }));
    this.connection.onRequest("workspace/configuration", ({ items }) => this.configuration(items));
    this.connection.onRequest("workspace/workspaceFolders", () => this.workspaceFolders);
    this.connection.onRequest("client/registerCapability", () => null);
    this.connection.onRequest("window/workDoneProgress/create", () => null);
    for (const method of [
      "workspace/codeLens/refresh",
      "workspace/inlayHint/refresh",
      "workspace/semanticTokens/refresh",
      "workspace/diagnostic/refresh",
    ])
      this.connection.onRequest(method, () => null);
    this.connection.listen();
    const rootUri = pathToFileURL(this.rootPath).href;
    this.workspaceFolders = [{ uri: rootUri, name: path.basename(this.rootPath) }];
    const result = await this.request("initialize", {
      processId: process.pid,
      clientInfo: { name: "Lumine Rust adapter specs", version: "1.0.0" },
      rootUri,
      workspaceFolders: this.workspaceFolders,
      initializationOptions: this.adapter.getInitializationOptions?.({
        ...serverContext({ rootPath: this.rootPath }),
        rootUri,
      }),
      capabilities: {
        workspace: {
          configuration: true,
          workspaceFolders: true,
          didChangeWatchedFiles: { dynamicRegistration: true },
          workspaceEdit: {
            documentChanges: true,
            resourceOperations: ["create", "rename", "delete"],
          },
          symbol: { dynamicRegistration: true },
          diagnostics: { refreshSupport: true },
          semanticTokens: { refreshSupport: true },
          inlayHint: { refreshSupport: true },
        },
        textDocument: {
          synchronization: { dynamicRegistration: false, didSave: true },
          publishDiagnostics: {
            relatedInformation: true,
            tagSupport: { valueSet: [1, 2] },
            dataSupport: true,
          },
          diagnostic: { dynamicRegistration: true, relatedDocumentSupport: true },
          completion: {
            completionItem: {
              snippetSupport: true,
              documentationFormat: ["markdown", "plaintext"],
              resolveSupport: { properties: ["documentation", "detail", "additionalTextEdits"] },
            },
          },
          hover: { contentFormat: ["markdown", "plaintext"] },
          signatureHelp: {
            signatureInformation: {
              documentationFormat: ["markdown", "plaintext"],
              parameterInformation: { labelOffsetSupport: true },
            },
          },
          definition: { linkSupport: true },
          references: {},
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          formatting: {},
          rename: { prepareSupport: true },
          callHierarchy: {},
          codeAction: {
            codeActionLiteralSupport: {
              codeActionKind: {
                valueSet: ["", "quickfix", "refactor", "refactor.inline", "refactor.rewrite"],
              },
            },
            resolveSupport: { properties: ["edit"] },
            dataSupport: true,
          },
          inlayHint: {
            resolveSupport: { properties: ["tooltip", "label.tooltip", "label.location"] },
          },
          semanticTokens: {
            requests: { full: { delta: true }, range: true },
            tokenTypes: [
              "namespace",
              "type",
              "class",
              "enum",
              "interface",
              "struct",
              "typeParameter",
              "parameter",
              "variable",
              "property",
              "enumMember",
              "event",
              "function",
              "method",
              "macro",
              "keyword",
              "modifier",
              "comment",
              "string",
              "number",
              "regexp",
              "operator",
              "decorator",
            ],
            tokenModifiers: [
              "declaration",
              "definition",
              "readonly",
              "static",
              "deprecated",
              "abstract",
              "async",
              "modification",
              "documentation",
              "defaultLibrary",
            ],
            formats: ["relative"],
            multilineTokenSupport: false,
            overlappingTokenSupport: false,
          },
        },
        window: { workDoneProgress: true },
        general: { positionEncodings: ["utf-16"] },
        experimental: { serverStatusNotification: true },
      },
    });
    this.capabilities = result.capabilities;
    await this.connection.sendNotification("initialized", {});
    await this.connection.sendNotification("workspace/didChangeConfiguration", {
      settings: (await this.adapter.getSettings?.(this.configurationContext())) ?? {},
    });
    return result;
  }
  async request(method, params, timeout) {
    try {
      return await withTimeout(this.connection.sendRequest(method, params), method, timeout);
    } catch (error) {
      error.message += `\nrust-analyzer stderr: ${this.stderr}`;
      throw error;
    }
  }
  open(uri, languageId, text) {
    this.documents.set(uri, { text, version: 1 });
    return this.connection.sendNotification("textDocument/didOpen", {
      textDocument: { uri, languageId, version: 1, text },
    });
  }
  async waitFor(check, label, timeout = 60000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      try {
        const result = await check();
        if (result) return result;
      } catch (error) {
        if (![-32801, -32802].includes(error.code)) throw error;
      }
      await delay(100);
    }
    throw new Error(`${label} timed out; stderr: ${this.stderr}`);
  }
  async stop() {
    if (!this.connection) return;
    const exited = new Promise((resolve) => {
      if (this.child.exitCode !== null || this.child.signalCode !== null) resolve();
      else this.child.once("exit", resolve);
    });
    try {
      await withTimeout(this.connection.sendRequest("shutdown"), "shutdown", 5000);
      await this.connection.sendNotification("exit");
      await withTimeout(exited, "rust-analyzer exit", 3000);
    } catch {
      this.child.kill();
      await withTimeout(exited, "rust-analyzer kill", 3000).catch(() => {});
    } finally {
      this.connection.dispose();
    }
  }
}

exports.LiveLspClient = LiveLspClient;
exports.fileUri = (filePath) => pathToFileURL(filePath).href;
exports.sameUri = (first, second) => {
  const normalize = (uri) => {
    const filePath = path.resolve(fileURLToPath(uri));
    return process.platform === "win32" ? filePath.toLowerCase() : filePath;
  };
  return normalize(first) === normalize(second);
};
exports.positionOf = (text, needle, occurrence = 0, offset = 0) => {
  let index = -1;
  for (let count = 0; count <= occurrence; count += 1) index = text.indexOf(needle, index + 1);
  if (index < 0) throw new Error(`Fixture does not contain ${needle}.`);
  const before = text.slice(0, index + offset).split("\n");
  return { line: before.length - 1, character: before.at(-1).length };
};
exports.applyTextEdits = (text, edits) => {
  const offset = ({ line, character }) =>
    text
      .split("\n")
      .slice(0, line)
      .reduce((total, row) => total + row.length + 1, 0) + character;
  for (const edit of [...edits].sort((a, b) => offset(b.range.start) - offset(a.range.start)))
    text =
      text.slice(0, offset(edit.range.start)) + edit.newText + text.slice(offset(edit.range.end));
  return text;
};
exports.workspaceEdits = (edit, uri) =>
  Object.entries(edit?.changes || {}).find(([key]) => exports.sameUri(key, uri))?.[1] ||
  edit?.documentChanges?.flatMap((change) =>
    change.textDocument?.uri && exports.sameUri(change.textDocument.uri, uri) ? change.edits : [],
  ) ||
  [];
