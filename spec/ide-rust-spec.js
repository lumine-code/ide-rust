const {
  createServerResolver,
  serverContext,
  installContext,
  serverApi,
} = require("./helpers/server-resolver");
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
    disposable = main.consumeIde({
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
    expect(adapter.getWorkspaceConfiguration).toBeUndefined();
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
    expect(main.consumeIde({ registerAdapter: () => first })).toBe(first);
    expect(main.consumeIde({ registerAdapter: () => second })).toBe(second);
    first.dispose();
    expect(second.dispose).not.toHaveBeenCalled();
  });
  it("obtains the current main module after package reload", async () => {
    const previous = main;
    disposable.dispose();
    await lumine.packages.deactivatePackage("ide-rust");
    await lumine.packages.unloadPackage("ide-rust");
    lumine.packages.loadPackage("ide-rust");
    const pkg = await lumine.packages.activatePackage("ide-rust");
    main = pkg.mainModule;
    server = require("../lib/server");
    register();
    expect(main).not.toBe(previous);
    expect(adapter.installServer).toBe(server.installServer);
    expect(main.provideBackgroundTips().packageName).toBe("ide-rust");
  });
  const nativeFixture = (directories) => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ide-rust-discovery-"));
    const paths = directories.map((directory) => path.join(scratch, directory));
    for (const directory of paths) fs.mkdirSync(directory);
    const binary = (directory, name) => {
      const command = path.join(directory, name + (process.platform === "win32" ? ".exe" : ""));
      fs.copyFileSync(process.execPath, command);
      fs.chmodSync(command, 0o755);
      return command;
    };
    return { paths, binary };
  };
  it("skips a broken rustup proxy and finds a working later PATH entry", async () => {
    const { paths, binary } = nativeFixture(["proxy", "native"]);
    const proxy = binary(paths[0], "rust-analyzer"),
      native = binary(paths[1], "rust-analyzer");
    spyOn(server, "probeServer").and.callFake(async (command) => {
      if (command === proxy) throw new Error("component not installed");
      return "native-version";
    });
    const context = serverContext({
      resolver: createServerResolver({ environment: { PATH: paths.join(path.delimiter) } }),
    });
    expect(await server.resolveServer(context)).toEqual({
      command: native,
      args: [],
      version: "native-version",
    });
    expect(server.probeServer.calls.allArgs().map(([command]) => command)).toEqual([proxy, native]);
  });
  it("uses rustup's real binary only after PATH candidates fail", async () => {
    const { paths, binary } = nativeFixture(["cargo", "toolchain"]);
    const rustup = binary(paths[0], "rustup"),
      analyzer = binary(paths[1], "rust-analyzer");
    spyOn(server, "run").and.resolveTo(analyzer);
    spyOn(server, "probeServer").and.resolveTo("component-version");
    const context = serverContext({
      resolver: createServerResolver({ environment: { PATH: paths[0] } }),
    });
    expect((await server.resolveServer(context)).command).toBe(analyzer);
    expect(server.run).toHaveBeenCalledWith(rustup, ["which", "rust-analyzer"], {});
  });
  it("treats an unavailable rustup component as a missing server", async () => {
    const { paths, binary } = nativeFixture(["cargo"]);
    binary(paths[0], "rustup");
    spyOn(server, "run").and.rejectWith(new Error("unknown binary"));
    const context = serverContext({
      resolver: createServerResolver({ environment: { PATH: paths[0] } }),
    });
    expect(await server.resolveServer(context)).toBeNull();
  });
  it("reports missing servers through the client instead of inventing a notification", async () => {
    const missing = jasmine.createSpy("reportMissingServer");
    main.consumeIde({
      registerAdapter(value) {
        adapter = value;
        return disposable;
      },
      reportMissingServer: missing,
    });
    spyOn(server, "resolveServer").and.resolveTo(null);
    expect(await adapter.resolveServer(serverContext({ rootPath: os.tmpdir() }))).toBeNull();
    const [id, options] = missing.calls.argsFor(0);
    expect(id).toBe("ide-rust");
    expect(typeof options.description).toBe("string");
    expect(options.description).toContain("rustup component add rust-analyzer");
  });
  it("does not silently replace a broken explicitly selected executable", async () => {
    spyOn(server, "probeServer").and.rejectWith(new Error("component not installed"));
    await expectAsync(
      server.resolveServer(serverContext(), process.execPath),
    ).toBeRejectedWithError(/configured rust-analyzer could not start/);
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
    expect(server.assetFor({ platform: "linux", arch: "x64", libc: "musl" })).toBe(
      "rust-analyzer-x86_64-unknown-linux-musl.gz",
    );
    expect(server.assetFor({ platform: "linux", arch: "arm64", libc: "musl" })).toBeNull();
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
      latestGithubRelease: jasmine.createSpy("release").and.resolveTo({
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
    const installed = await server.installServer(installContext({ storagePath: scratch, api }), {
      platform: "linux",
      arch: "x64",
    });
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
      server.installServer(installContext({ storagePath: os.tmpdir(), api }), {
        platform: "linux",
        arch: "x64",
      }),
    ).toBeRejectedWithError(/does not contain/);
    api.latestGithubRelease = async () => ({
      version: "2026-09-28",
      assets: [{ name: "rust-analyzer-x86_64-unknown-linux-gnu.gz" }],
    });
    await expectAsync(
      server.installServer(installContext({ storagePath: os.tmpdir(), api }), {
        platform: "linux",
        arch: "x64",
      }),
    ).toBeRejectedWithError(/SHA-256/);
    expect(api.downloadFile).not.toHaveBeenCalled();
    await expectAsync(
      server.installServer(installContext({ storagePath: os.tmpdir(), api }), {
        platform: "aix",
        arch: "ppc64",
      }),
    ).toBeRejectedWithError(/no managed build/);
  });
  it("installs the requested release without substituting the newest one", async () => {
    const api = {
      setServerInstallationStatus() {},
      latestGithubRelease: jasmine.createSpy("latest"),
      githubReleaseByTag: jasmine
        .createSpy("byTag")
        .and.resolveTo({ version: "2026-09-21", assets: [] }),
    };
    await expectAsync(
      server.installServer(
        installContext({ storagePath: os.tmpdir(), version: "2026-09-21", api }),
        { platform: "linux", arch: "x64" },
      ),
    ).toBeRejectedWithError(/does not contain/);
    expect(api.githubReleaseByTag).toHaveBeenCalledOnceWith(
      "rust-lang/rust-analyzer",
      "2026-09-21",
    );
    expect(api.latestGithubRelease).not.toHaveBeenCalled();
  });
  it("extracts a verified Windows zip through the hub install API", async () => {
    scratch = await fs.promises.mkdtemp(
      path.join(process.env.IDE_RUST_TEST_TMP || os.tmpdir(), "ide-rust-install-"),
    );
    const digest = `sha256:${"b".repeat(64)}`;
    const api = {
      setServerInstallationStatus() {},
      latestGithubRelease: async () => ({
        version: "2026-09-28",
        assets: [
          {
            name: "rust-analyzer-x86_64-pc-windows-msvc.zip",
            url: "https://example.test/server.zip",
            digest,
          },
        ],
      }),
      downloadFile: jasmine
        .createSpy("download")
        .and.callFake(async (_url, destination) =>
          fs.promises.writeFile(path.join(destination, "rust-analyzer.exe"), "native-server"),
        ),
      makeFileExecutable: jasmine
        .createSpy("executable")
        .and.callFake((filePath) => fs.promises.chmod(filePath, 0o755)),
    };
    expect(
      await server.installServer(installContext({ storagePath: scratch, api }), {
        platform: "win32",
        arch: "x64",
      }),
    ).toEqual({ version: "2026-09-28", binary: "rust-analyzer.exe" });
    expect(api.downloadFile).toHaveBeenCalledWith("https://example.test/server.zip", scratch, {
      type: "zip",
      digest,
    });
  });
  it("looks up the newest stable release through the hub", async () => {
    const api = {
      latestGithubRelease: jasmine.createSpy("release").and.resolveTo({ version: "2026-09-28" }),
    };
    expect(await server.latestServerVersion(serverApi(api))).toBe("2026-09-28");
    expect(api.latestGithubRelease).toHaveBeenCalledWith("rust-lang/rust-analyzer");
  });
});
