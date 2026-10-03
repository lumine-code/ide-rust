const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { gzipSync } = require("node:zlib");

describe("ide-rust adapter and server management", () => {
  let main, server, adapter, disposable, changed, scratch;
  const configure = (name, value) => {
    changed.add(name);
    lumine.config.set(`ide-rust.${name}`, value);
  };
  const register = () => {
    disposable = main.consumeIdeClient({
      registerAdapter(value) {
        adapter = value;
        return { dispose: jasmine.createSpy("dispose") };
      },
      reportMissingServer: jasmine.createSpy("reportMissingServer"),
    });
  };

  beforeEach(async () => {
    jasmine.useRealClock();
    // Lifecycle teardown discards modules. Obtain every implementation from
    // the newly activated generation, never a top-level require of lib/.
    const pkg = await lumine.packages.activatePackage("ide-rust");
    main = pkg.mainModule;
    server = require("../lib/server");
    changed = new Set();
    register();
  });
  afterEach(async () => {
    disposable?.dispose();
    for (const name of changed) lumine.config.unset(`ide-rust.${name}`);
    await lumine.packages.deactivatePackage("ide-rust");
    if (scratch) await fs.promises.rm(scratch, { recursive: true, force: true });
    scratch = null;
  });

  it("returns the service edge disposable and registers only Rust", () => {
    expect(disposable.dispose).not.toHaveBeenCalled();
    expect(adapter.id).toBe("ide-rust");
    expect(adapter.grammarScopes).toEqual(["source.rust"]);
    expect(adapter.languageId).toBe("rust");
    expect(adapter.restartKeyPaths).toEqual(["ide-rust.serverPath", "ide-rust.toolchain"]);
    expect(adapter.managedServer).toBeUndefined();
    expect(adapter.installServer).toBe(server.installServer);
  });
  it("preserves server defaults and leaves unrelated configuration alone", () => {
    expect(adapter.getInitializationOptions()).toEqual({});
    expect(adapter.getSettings()).toEqual({ "rust-analyzer": {} });
    expect(adapter.getWorkspaceConfiguration("rust-analyzer")).toEqual({});
    expect(adapter.getWorkspaceConfiguration("rust-analyzer.cargo")).toBeUndefined();
    expect(adapter.getWorkspaceConfiguration("editor")).toBeUndefined();
  });
  it("maps explicit check, Cargo and macro overrides consistently", () => {
    configure("checkOnSave", "disabled");
    configure("checkCommand", "clippy");
    configure("cargoFeatures", ["serialization"]);
    configure("cargoTarget", "wasm32-unknown-unknown");
    configure("allTargets", "disabled");
    configure("buildScripts", "disabled");
    configure("procMacros", "enabled");
    const expected = {
      checkOnSave: false,
      check: { command: "clippy" },
      cargo: {
        features: ["serialization"],
        target: "wasm32-unknown-unknown",
        allTargets: false,
        buildScripts: { enable: false },
      },
      procMacro: { enable: true },
    };
    expect(adapter.getInitializationOptions()).toEqual(expected);
    expect(adapter.getSettings()).toEqual({ "rust-analyzer": expected });
    expect(adapter.getWorkspaceConfiguration("rust-analyzer.check.command")).toBe("clippy");
    configure("allFeatures", true);
    expect(adapter.getInitializationOptions().cargo.features).toBe("all");
  });
  it("maps independent inlay controls without forcing other inlay settings", () => {
    configure("typeHints", "disabled");
    configure("parameterHints", "enabled");
    expect(adapter.getInitializationOptions()).toEqual({
      inlayHints: { typeHints: { enable: false }, parameterHints: { enable: true } },
    });
  });
  it("does not offer unsupported type hierarchy or client-only code lenses", () => {
    const properties = require("../package.json").configSchema.features.properties;
    expect(properties.callHierarchy).toBeDefined();
    expect(properties.typeHierarchy).toBeUndefined();
    expect(properties.codeLens).toBeUndefined();
    expect(adapter.isFeatureAvailable("codeLens")).toBe(false);
    expect(adapter.isFeatureAvailable("codeActions")).toBe(true);
  });
  it("publishes one useful tip with the exact package identity", () => {
    const tip = main.provideBackgroundTips();
    expect(tip.packageName).toBe("ide-rust");
    expect(tip.tips.length).toBe(1);
    expect(tip.tips[0]).toContain("rust-src");
  });
  it("returns independent disposables when a provider reconnects", () => {
    const first = { dispose: jasmine.createSpy("first") };
    const second = { dispose: jasmine.createSpy("second") };
    expect(main.consumeIdeClient({ registerAdapter: () => first })).toBe(first);
    expect(main.consumeIdeClient({ registerAdapter: () => second })).toBe(second);
    first.dispose();
    expect(second.dispose).not.toHaveBeenCalled();
  });
  it("obtains the current main module after package reload", async () => {
    const previous = main;
    disposable.dispose();
    await lumine.packages.deactivatePackage("ide-rust");
    lumine.packages.unloadPackage("ide-rust");
    const pkg = await lumine.packages.activatePackage("ide-rust");
    main = pkg.mainModule;
    server = require("../lib/server");
    register();
    expect(main).not.toBe(previous);
    expect(adapter.installServer).toBe(server.installServer);
    expect(main.provideBackgroundTips().packageName).toBe("ide-rust");
  });
  it("prefers the configured executable, then managed, before discovery", async () => {
    spyOn(server, "probeServer").and.resolveTo("test-version");
    spyOn(server, "executablesOnPath").and.returnValue([]);
    const managed = { binaryPath: "/managed/rust-analyzer", version: "2026-09-28" };
    expect((await server.resolveServer(process.execPath, managed)).command).toBe(process.execPath);
    expect(await server.resolveServer("", managed)).toEqual({
      command: managed.binaryPath,
      args: [],
      version: managed.version,
    });
    expect(server.executablesOnPath).not.toHaveBeenCalled();
  });
  it("skips a broken rustup proxy and finds a working later PATH entry", async () => {
    spyOn(server, "executablesOnPath").and.returnValue([
      "/proxy/rust-analyzer",
      "/native/rust-analyzer",
    ]);
    spyOn(server, "probeServer").and.callFake(async (command) => {
      if (command.startsWith("/proxy")) throw new Error("component not installed");
      return "native-version";
    });
    expect(await server.resolveServer("")).toEqual({
      command: "/native/rust-analyzer",
      args: [],
      version: "native-version",
    });
  });
  it("uses rustup's real binary only after PATH candidates fail", async () => {
    spyOn(server, "executablesOnPath").and.callFake((name) =>
      name === "rustup" ? ["/cargo/rustup"] : [],
    );
    spyOn(server, "run").and.resolveTo("/toolchain/rust-analyzer");
    spyOn(server, "probeServer").and.resolveTo("component-version");
    expect((await server.resolveServer("")).command).toBe("/toolchain/rust-analyzer");
    expect(server.run).toHaveBeenCalledWith("/cargo/rustup", ["which", "rust-analyzer"], {});
  });
  it("treats an unavailable rustup component as a missing server", async () => {
    spyOn(server, "executablesOnPath").and.callFake((name) =>
      name === "rustup" ? ["/cargo/rustup"] : [],
    );
    spyOn(server, "run").and.rejectWith(new Error("unknown binary"));
    expect(await server.resolveServer("")).toBeNull();
  });
  it("reports missing servers through the client instead of inventing a notification", async () => {
    const missing = jasmine.createSpy("reportMissingServer");
    main.consumeIdeClient({
      registerAdapter(value) {
        adapter = value;
        return disposable;
      },
      reportMissingServer: missing,
    });
    spyOn(server, "resolveServer").and.resolveTo(null);
    expect(await adapter.resolveServer({ rootPath: os.tmpdir() })).toBeNull();
    expect(missing).toHaveBeenCalledWith(
      "ide-rust",
      jasmine.objectContaining({
        description: jasmine.stringMatching(/rustup component add rust-analyzer/),
      }),
    );
  });
  it("does not silently replace a broken explicitly selected executable", async () => {
    spyOn(server, "probeServer").and.rejectWith(new Error("component not installed"));
    spyOn(server, "executablesOnPath");
    await expectAsync(server.resolveServer(process.execPath)).toBeRejectedWithError(
      /configured rust-analyzer could not start/,
    );
    expect(server.executablesOnPath).not.toHaveBeenCalled();
  });
  it("checks version output rather than accepting any executable", async () => {
    spyOn(server, "run").and.resolveTo("v24.18.0");
    await expectAsync(server.probeServer(process.execPath)).toBeRejectedWithError(
      /not a rust-analyzer/,
    );
  });
  it("selects a toolchain without mutating the process environment", () => {
    const previous = process.env.RUSTUP_TOOLCHAIN;
    expect(server.rustEnvironment("nightly").RUSTUP_TOOLCHAIN).toBe("nightly");
    expect(server.rustEnvironment("").RUSTUP_TOOLCHAIN).toBeUndefined();
    expect(process.env.RUSTUP_TOOLCHAIN).toBe(previous);
  });
  it("finds executable files on a synthetic PATH and ignores directories", () => {
    const name = path.basename(process.execPath, path.extname(process.execPath));
    expect(server.executablesOnPath(name, { PATH: path.dirname(process.execPath) })).toContain(
      process.execPath,
    );
    expect(
      server.executablesOnPath("absent-language-server", { PATH: path.dirname(process.execPath) }),
    ).toEqual([]);
  });
  it("selects exact native release assets on supported platforms", () => {
    expect(server.assetFor({ platform: "win32", arch: "x64" })).toBe(
      "rust-analyzer-x86_64-pc-windows-msvc.zip",
    );
    expect(server.assetFor({ platform: "darwin", arch: "arm64" })).toBe(
      "rust-analyzer-aarch64-apple-darwin.gz",
    );
    expect(server.assetFor({ platform: "linux", arch: "x64" })).toBe(
      "rust-analyzer-x86_64-unknown-linux-gnu.gz",
    );
    expect(server.assetFor({ platform: "linux", arch: "arm" })).toBe(
      "rust-analyzer-arm-unknown-linux-gnueabihf.gz",
    );
    expect(server.assetFor({ platform: "aix", arch: "ppc64" })).toBeNull();
  });
  it("expands a verified Unix gzip and returns the managed binary", async () => {
    scratch = await fs.promises.mkdtemp(
      path.join(process.env.IDE_RUST_TEST_TMP || os.tmpdir(), "ide-rust-install-"),
    );
    const digest = `sha256:${"a".repeat(64)}`;
    const api = {
      setServerInstallationStatus: jasmine.createSpy("status"),
      latestGithubRelease: jasmine
        .createSpy("release")
        .and.resolveTo({
          version: "2026-09-28",
          assets: [
            {
              name: "rust-analyzer-x86_64-unknown-linux-gnu.gz",
              url: "https://example.test/server.gz",
              digest,
            },
          ],
        }),
      downloadFile: jasmine
        .createSpy("download")
        .and.callFake(async (_url, destination) =>
          fs.promises.writeFile(destination, gzipSync("native-server")),
        ),
      makeFileExecutable: jasmine
        .createSpy("executable")
        .and.callFake((filePath) => fs.promises.chmod(filePath, 0o755)),
    };
    const installed = await server.installServer(
      { storagePath: scratch, api },
      { platform: "linux", arch: "x64" },
    );
    expect(installed).toEqual({ version: "2026-09-28", binary: "rust-analyzer" });
    expect(api.downloadFile).toHaveBeenCalledWith(
      "https://example.test/server.gz",
      path.join(scratch, "rust-analyzer.gz"),
      { type: "uncompressed", digest },
    );
    expect(fs.readFileSync(path.join(scratch, installed.binary), "utf8")).toBe("native-server");
    expect(fs.existsSync(path.join(scratch, "rust-analyzer.gz"))).toBe(false);
  });
  it("refuses a release without the exact binary or verification digest", async () => {
    const api = {
      setServerInstallationStatus() {},
      latestGithubRelease: async () => ({ version: "2026-09-28", assets: [] }),
      downloadFile: jasmine.createSpy("download"),
    };
    await expectAsync(
      server.installServer({ storagePath: os.tmpdir(), api }, { platform: "linux", arch: "x64" }),
    ).toBeRejectedWithError(/does not contain/);
    api.latestGithubRelease = async () => ({
      version: "2026-09-28",
      assets: [{ name: "rust-analyzer-x86_64-unknown-linux-gnu.gz" }],
    });
    await expectAsync(
      server.installServer({ storagePath: os.tmpdir(), api }, { platform: "linux", arch: "x64" }),
    ).toBeRejectedWithError(/SHA-256/);
    expect(api.downloadFile).not.toHaveBeenCalled();
    await expectAsync(
      server.installServer({ storagePath: os.tmpdir(), api }, { platform: "aix", arch: "ppc64" }),
    ).toBeRejectedWithError(/no managed build/);
  });
});
