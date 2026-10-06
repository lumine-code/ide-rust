const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const childProcess = require("node:child_process");
const { gunzip } = require("node:zlib");
const { promisify } = require("node:util");

const REPOSITORY = "rust-lang/rust-analyzer";
const TARGETS = {
  win32: {
    x64: "x86_64-pc-windows-msvc",
    arm64: "aarch64-pc-windows-msvc",
    ia32: "i686-pc-windows-msvc",
  },
  darwin: { x64: "x86_64-apple-darwin", arm64: "aarch64-apple-darwin" },
  linux: {
    x64: "x86_64-unknown-linux-gnu",
    arm64: "aarch64-unknown-linux-gnu",
    arm: "arm-unknown-linux-gnueabihf",
  },
};

exports.assetFor = ({ platform, arch, libc }) => {
  const target =
    platform === "linux" && libc === "musl"
      ? arch === "x64"
        ? "x86_64-unknown-linux-musl"
        : null
      : TARGETS[platform]?.[arch];
  return target ? `rust-analyzer-${target}.${platform === "win32" ? "zip" : "gz"}` : null;
};

exports.currentTarget = () => ({
  platform: process.platform,
  arch: process.arch,
  ...(process.platform === "linux" && {
    libc: process.report?.getReport()?.header.glibcVersionRuntime ? "gnu" : "musl",
  }),
});

// A GUI launched outside a Rust shell still needs Cargo and the rustup proxies.
// Preserve the existing PATH order and the project's rust-toolchain.toml unless
// the user explicitly selects a toolchain.
exports.rustEnvironment = (toolchain = "", env = process.env) => {
  const result = toolchain ? { RUSTUP_TOOLCHAIN: toolchain } : {};
  const cargoBin = path.join(env.CARGO_HOME || path.join(os.homedir(), ".cargo"), "bin");
  const current = env.PATH || env.Path || "";
  const canonical = (value) => (process.platform === "win32" ? value.toLowerCase() : value);
  if (
    fs.existsSync(cargoBin) &&
    !current.split(path.delimiter).some((entry) => canonical(entry) === canonical(cargoBin))
  ) {
    const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") || "PATH";
    result[pathKey] = current ? `${current}${path.delimiter}${cargoBin}` : cargoBin;
  }
  return result;
};

exports.run = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    childProcess.execFile(
      command,
      args,
      { ...options, windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) reject(new Error(String(stderr || error.message).trim(), { cause: error }));
        else resolve(String(stdout).trim());
      },
    );
  });

exports.probeServer = async (command, options) => {
  const output = await exports.run(command, ["--version"], options);
  if (!/^rust-analyzer\s+\S+/.test(output))
    throw new Error(`${command} is not a rust-analyzer executable.`);
  return output.replace(/^rust-analyzer\s+/, "");
};

exports.resolveServer = async (context, configuredPath = "", options = {}) => {
  options = { ...options, ...(context.signal && { signal: context.signal }) };
  const validate = async (command, { source }) => {
    try {
      return { version: await exports.probeServer(command, options) };
    } catch (error) {
      if (source === "configured")
        throw new Error(`The configured rust-analyzer could not start: ${error.message}`, {
          cause: error,
        });
      throw error;
    }
  };
  const selection = await context.resolver.select({
    kind: "executable",
    configuredPath,
    managed: () => {
      const installed = context.getManagedServer();
      return installed ? { path: installed.binaryPath, version: installed.version } : null;
    },
    names: ["rust-analyzer"],
    env: options.env,
    cwd: options.cwd,
    signal: context.signal,
    validate,
  });
  if (selection)
    return context.resolver.launch(selection, {
      signal: context.signal,
      args: [],
      version: selection.version || selection.data.version,
    });
  // A broken rustup proxy must not shadow a working later PATH entry. Ask
  // rustup for its real component only after the hub has exhausted them all.
  const component = await context.resolver.select({
    kind: "executable",
    candidates: async () => {
      const rustup = context.resolver.findExecutables("rustup", { env: options.env })[0];
      if (!rustup) return [];
      try {
        return [await exports.run(rustup, ["which", "rust-analyzer"], options)];
      } catch {
        return [];
      }
    },
    signal: context.signal,
    validate,
  });
  return component
    ? context.resolver.launch(component, { args: [], version: component.data.version })
    : null;
};

exports.latestServerVersion = async (api) => (await api.latestGithubRelease(REPOSITORY)).version;

exports.installServer = async ({ storagePath, api, version }, target = exports.currentTarget()) => {
  const assetName = exports.assetFor(target);
  if (!assetName)
    throw new Error(`rust-analyzer has no managed build for ${target.platform}/${target.arch}.`);
  api.setServerInstallationStatus("checking");
  const release = version
    ? await api.githubReleaseByTag(REPOSITORY, version)
    : await api.latestGithubRelease(REPOSITORY);
  const asset = release.assets.find(({ name }) => name === assetName);
  if (!asset) throw new Error(`rust-analyzer ${release.version} does not contain ${assetName}.`);
  if (!/^sha256:[a-f0-9]{64}$/i.test(asset.digest || ""))
    throw new Error(`No SHA-256 digest is available for ${assetName}.`);
  const binary = target.platform === "win32" ? "rust-analyzer.exe" : "rust-analyzer";
  api.setServerInstallationStatus("downloading");
  if (target.platform === "win32") {
    await api.downloadFile(asset.url, storagePath, { type: "zip", digest: asset.digest });
  } else {
    // The hub handles archives; these Unix assets contain one gzip-compressed
    // executable. Verify the compressed download before expanding it ourselves.
    const archive = path.join(storagePath, `${binary}.gz`);
    await api.downloadFile(asset.url, archive, { type: "uncompressed", digest: asset.digest });
    api.setServerInstallationStatus("installing");
    const payload = await promisify(gunzip)(await fs.promises.readFile(archive));
    await fs.promises.writeFile(path.join(storagePath, binary), payload);
    await fs.promises.unlink(archive);
  }
  api.setServerInstallationStatus("installing");
  await api.makeFileExecutable(path.join(storagePath, binary));
  await fs.promises.access(path.join(storagePath, binary), fs.constants.X_OK);
  return { version: release.version, binary };
};
