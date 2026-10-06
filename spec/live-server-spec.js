const path = require("node:path");
const {
  LiveLspClient,
  fileUri,
  sameUri,
  positionOf,
  applyTextEdits,
  workspaceEdits,
} = require("./helpers/live-lsp-client");
const { createProject, removeProject } = require("./helpers/rust-project");

const serverPath = process.env.RUST_ANALYZER_PATH;
const liveSuite = serverPath || process.env.RUST_ANALYZER_REQUIRED ? describe : xdescribe;
const liveIt = (description, spec) => it(description, spec, 90000);

liveSuite("ide-rust official rust-analyzer", () => {
  let client, adapter, project, uri, initialized, registration, originalTimeout;
  const position = (needle, offset = 0) => positionOf(project.source, needle, 0, offset);
  const documentRequest = (method, extra = {}) =>
    client.request(method, { textDocument: { uri }, ...extra });

  beforeEach(async () => {
    jasmine.useRealClock();
    originalTimeout = jasmine.DEFAULT_TIMEOUT_INTERVAL;
    jasmine.DEFAULT_TIMEOUT_INTERVAL = 90000;
    if (!serverPath) throw new Error("RUST_ANALYZER_REQUIRED needs a real RUST_ANALYZER_PATH.");
    project = createProject();
    uri = fileUri(project.filePath);
    const pkg = await lumine.packages.activatePackage("ide-rust");
    lumine.config.set("ide-rust.serverPath", serverPath);
    registration = pkg.mainModule.consumeIdeClient({
      registerAdapter(value) {
        adapter = value;
        return { dispose() {} };
      },
      reportMissingServer() {
        throw new Error("The official rust-analyzer must start.");
      },
    });
    client = new LiveLspClient(adapter, project.rootPath);
    initialized = await client.start();
    await client.open(uri, "rust", project.source);
    // Hover can answer before rust-analyzer finishes loading its VFS. During
    // that load semantic-token requests deliberately return null, so use the
    // server's readiness signal before making semantic assertions.
    await client.waitFor(
      () =>
        client.notifications.findLast(({ method }) => method === "experimental/serverStatus")
          ?.params.quiescent,
      "Rust project loading",
    );
    await client.waitFor(
      async () =>
        (await documentRequest("textDocument/hover", { position: position("add(1", 1) }))?.contents,
      "Rust project indexing",
    );
  }, 90000);
  afterEach(async () => {
    await client?.stop();
    registration?.dispose();
    lumine.config.unset("ide-rust.serverPath");
    await lumine.packages.deactivatePackage("ide-rust");
    if (project) await removeProject(project.rootPath);
    jasmine.DEFAULT_TIMEOUT_INTERVAL = originalTimeout;
  }, 30000);

  liveIt("runs the pinned official server and exposes only implemented switches", () => {
    expect(initialized.serverInfo.name).toBe("rust-analyzer");
    if (process.env.RUST_ANALYZER_EXPECTED_VERSION)
      expect(initialized.serverInfo.version).toContain(process.env.RUST_ANALYZER_EXPECTED_VERSION);
    expect(initialized.capabilities.typeHierarchyProvider).toBeUndefined();
    expect(adapter.isFeatureAvailable("codeLens")).toBe(false);
  });
  liveIt("reports a real type mismatch through pull diagnostics", async () => {
    const report = await client.waitFor(async () => {
      const result = await documentRequest("textDocument/diagnostic", {
        identifier: "rust-analyzer",
      });
      return result.items?.some(({ code }) => code === "E0308") && result;
    }, "type-mismatch diagnostics");
    const error = report.items.find(({ code }) => code === "E0308");
    expect(error.message).toMatch(/expected i32.*str/);
    expect(error.range.start.line).toBe(position('"wrong"').line);
    expect(error.severity).toBe(1);
  });
  liveIt("completes project methods and resolves their signatures", async () => {
    const result = await documentRequest("textDocument/completion", {
      position: position("point.sum", 6),
    });
    const item = result.items.find(({ label }) => label === "sum");
    expect(item).toBeDefined();
    expect(item.kind).toBe(2);
    expect(item.textEdit.newText).toContain("sum");
    const resolved = await client.request("completionItem/resolve", item);
    expect(resolved.detail).toBe("fn(&self) -> i32");
  });
  liveIt("serves project documentation and argument signature help", async () => {
    const hover = await documentRequest("textDocument/hover", { position: position("add(1", 1) });
    expect(hover.contents.value).toContain("Adds two integer values.");
    expect(hover.contents.value).toContain("pub fn add(left: i32, right: i32) -> i32");
    const help = await documentRequest("textDocument/signatureHelp", {
      position: position("add(1", 5),
    });
    expect(help.signatures[0].label).toBe("fn add(left: i32, right: i32) -> i32");
    expect(help.signatures[0].parameters.length).toBe(2);
    expect(help.activeParameter).toBe(0);
  });
  liveIt("finds definitions and references across Rust modules", async () => {
    const definitions = await documentRequest("textDocument/definition", {
      position: position("add(1", 1),
    });
    expect(sameUri(definitions[0].targetUri, uri)).toBe(true);
    expect(definitions[0].targetSelectionRange.start).toEqual(position("fn add", 3));
    const references = await documentRequest("textDocument/references", {
      position: position("fn add", 4),
      context: { includeDeclaration: false },
    });
    expect(references.length).toBe(2);
    expect(
      references.some((item) =>
        sameUri(item.uri, fileUri(path.join(project.rootPath, "src", "model.rs"))),
      ),
    ).toBe(true);
  });
  liveIt("renames both the declaration and calls in different modules", async () => {
    const prepared = await documentRequest("textDocument/prepareRename", {
      position: position("fn add", 4),
    });
    expect(prepared.range || prepared).toBeDefined();
    const edits = await documentRequest("textDocument/rename", {
      position: position("fn add", 4),
      newName: "combine",
    });
    const renamed = applyTextEdits(project.source, workspaceEdits(edits, uri));
    expect(renamed).toContain("pub fn combine(left:");
    expect(renamed).toContain("let count = combine(1, 2)");
    const modelUri = fileUri(path.join(project.rootPath, "src", "model.rs"));
    expect(applyTextEdits(project.model, workspaceEdits(edits, modelUri))).toContain(
      "crate::combine(self.x, self.y)",
    );
  });
  liveIt("returns document symbols and indexed workspace symbols", async () => {
    const symbols = await documentRequest("textDocument/documentSymbol");
    expect(symbols.map(({ name }) => name)).toContain("caller");
    expect(symbols.find(({ name }) => name === "add").detail).toContain("i32");
    const workspace = await client.request("workspace/symbol", { query: "Point" });
    expect(
      workspace.some(({ name, location }) => name === "Point" && location.uri.endsWith("model.rs")),
    ).toBe(true);
  });
  liveIt("formats Rust code using the installed rustfmt", async () => {
    const edits = await documentRequest("textDocument/formatting", {
      options: { tabSize: 4, insertSpaces: true },
    });
    expect(edits.length).toBeGreaterThan(0);
    const formatted = applyTextEdits(project.source, edits);
    expect(formatted).toContain("-> i32 {\n    left + right\n}");
    expect(formatted).toContain('pub fn wrong() -> i32 {\n    "wrong"\n}');
  });
  liveIt("provides inferred type and parameter-name hints", async () => {
    const hints = await documentRequest("textDocument/inlayHint", {
      range: { start: { line: 0, character: 0 }, end: { line: 13, character: 0 } },
    });
    const labels = hints.map(({ label }) =>
      typeof label === "string" ? label : label.map(({ value }) => value).join(""),
    );
    expect(labels).toContain(": i32");
    expect(labels).toContain("left:");
    expect(labels).toContain(": Point");
  });
  liveIt("resolves and applies an actual inline-variable refactoring", async () => {
    const actions = await documentRequest("textDocument/codeAction", {
      range: { start: position("let count", 4), end: position("let count", 9) },
      context: { diagnostics: [] },
    });
    const action = actions.find(({ title }) => title === "Inline variable");
    expect(action).toBeDefined();
    const resolved = await client.request("codeAction/resolve", action);
    expect(resolved.command).toBeUndefined();
    const changed = applyTextEdits(project.source, workspaceEdits(resolved.edit, uri));
    expect(changed).not.toContain("let count");
    expect(changed).toContain("Point { x: add(1, 2), y: 0 }");
  });
  liveIt("classifies actual function declarations as semantic tokens", async () => {
    const tokens = await documentRequest("textDocument/semanticTokens/full");
    const legend = initialized.capabilities.semanticTokensProvider.legend;
    const rows = project.source.split("\n");
    let line = 0,
      character = 0;
    const decoded = [];
    for (let index = 0; index < tokens.data.length; index += 5) {
      const [deltaLine, deltaCharacter, length, type, modifiers] = tokens.data.slice(
        index,
        index + 5,
      );
      line += deltaLine;
      character = deltaLine ? deltaCharacter : character + deltaCharacter;
      decoded.push({
        text: rows[line].slice(character, character + length),
        type: legend.tokenTypes[type],
        declaration: !!(modifiers & (1 << legend.tokenModifiers.indexOf("declaration"))),
      });
    }
    expect(decoded).toContain(
      jasmine.objectContaining({ text: "add", type: "function", declaration: true }),
    );
    expect(decoded).toContain(jasmine.objectContaining({ text: "sum", type: "method" }));
  });
  liveIt("finds callers using the returned call-hierarchy item", async () => {
    const items = await documentRequest("textDocument/prepareCallHierarchy", {
      position: position("fn add", 4),
    });
    expect(items[0].name).toBe("add");
    const incoming = await client.request("callHierarchy/incomingCalls", { item: items[0] });
    expect(incoming.map(({ from }) => from.name).sort()).toEqual(["caller", "sum"]);
    expect(incoming.every(({ fromRanges }) => fromRanges.length === 1)).toBe(true);
  });
});

liveSuite("ide-rust through the real ide-client service", () => {
  let project, editor, service, originalPaths, originalTimeout;

  beforeEach(async () => {
    jasmine.useRealClock();
    originalTimeout = jasmine.DEFAULT_TIMEOUT_INTERVAL;
    jasmine.DEFAULT_TIMEOUT_INTERVAL = 90000;
    project = createProject();
    originalPaths = lumine.project.getPaths();
    await lumine.packages.activatePackage("ide-rust");
    lumine.config.set("ide-rust.serverPath", serverPath);
    const clientPackage = await lumine.packages.activatePackage("ide-client");
    service = clientPackage.mainModule.provideIdeClient();
    await lumine.packages.activatePackage("language-rust");
    lumine.project.setPaths([project.rootPath]);
    editor = await lumine.workspace.open(project.filePath);
    editor.setGrammar(lumine.grammars.grammarForScopeName("source.rust"));
  }, 90000);
  afterEach(async () => {
    lumine.config.unset("ide-rust.features.hover");
    for (const session of service?.getSessions() || [])
      if (session.adapter.id === "ide-rust") await service.stop(session);
    for (const item of lumine.workspace.getTextEditors())
      if (item.getPath()?.startsWith(project.rootPath)) item.destroy();
    lumine.project.setPaths(originalPaths);
    await lumine.packages.deactivatePackage("ide-rust");
    await lumine.packages.deactivatePackage("ide-client");
    lumine.config.unset("ide-rust.serverPath");
    await removeProject(project.rootPath);
    jasmine.DEFAULT_TIMEOUT_INTERVAL = originalTimeout;
  }, 30000);

  liveIt("routes Rust requests, honors feature switches and applies project renames", async () => {
    const waitFor = async (check, label) => {
      const deadline = Date.now() + 60000;
      while (Date.now() < deadline) {
        const value = await check();
        if (value) return value;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(`${label} timed out.`);
    };
    const session = await waitFor(
      () => service.activeSessionForFeature(editor, "textDocument/hover", "hover"),
      "Rust session",
    );
    expect(session.adapter.id).toBe("ide-rust");
    const uri = fileUri(project.filePath);
    const params = { textDocument: { uri }, position: positionOf(project.source, "add(1", 0, 1) };
    const hover = await waitFor(async () => {
      try {
        return await session.request("textDocument/hover", params);
      } catch (error) {
        if ([-32801, -32802].includes(error.code)) return null;
        throw error;
      }
    }, "Rust hover through ide-client");
    expect(hover.contents.value).toContain("Adds two integer values.");
    lumine.config.set("ide-rust.features.hover", false);
    expect(await service.activeSessionForFeature(editor, "textDocument/hover", "hover")).toBeNull();
    lumine.config.set("ide-rust.features.hover", true);
    expect(await service.activeSessionForFeature(editor, "textDocument/hover", "hover")).toBe(
      session,
    );
    expect(
      await service.activeSessionForFeature(editor, "textDocument/codeLens", "codeLens"),
    ).toBeNull();
    const edits = await session.request("textDocument/rename", {
      textDocument: { uri },
      position: positionOf(project.source, "fn add", 0, 4),
      newName: "combine",
    });
    const applied = await service.applyWorkspaceEdit(edits, "Rename Rust function", session);
    if (!applied) {
      throw new Error(
        `Rust workspace edit was refused: ${lumine.notifications
          .getNotifications()
          .map((notification) => notification.getDetail())
          .join("; ")}`,
      );
    }
    expect(editor.getText()).toContain("pub fn combine(left:");
    expect(editor.getText()).toContain("combine(1, 2)");
    const modelEditor = lumine.workspace
      .getTextEditors()
      .find((item) => item.getPath()?.endsWith(`${path.sep}model.rs`));
    expect(modelEditor.getText()).toContain("crate::combine(self.x, self.y)");
  });
});
