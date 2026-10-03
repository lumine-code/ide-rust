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

exports.executablesOnPath = (name, env = process.env) => {
  const candidates = new Set();
  for (const directory of (env.PATH || env.Path || "").split(path.delimiter)) {
    if (!directory) continue;
    const base = path.join(directory.replace(/^"|"$/g, ""), name);
    for (const candidate of process.platform === "win32" ? [`${base}.exe`, base] : [base]) {
      try {
        if (!fs.statSync(candidate).isFile()) continue;
        fs.accessSync(candidate, fs.constants.X_OK);
        candidates.add(candidate);
      } catch {
        // This entry may belong to another machine or an uninstalled tool.
      }
    }
  }
  return [...candidates];
};

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
    result.PATH = current ? `${current}${path.delimiter}${cargoBin}` : cargoBin;
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

exports.resolveServer = async (configuredPath, managed = null, options = {}) => {
  if (configuredPath) {
    await fs.promises.access(configuredPath, fs.constants.X_OK);
    try {
      return {
        command: configuredPath,
        args: [],
        version: await exports.probeServer(configuredPath, options),
      };
    } catch (error) {
      throw new Error(`The configured rust-analyzer could not start: ${error.message}`, {
        cause: error,
      });
    }
  }
  if (managed?.binaryPath) {
    await exports.probeServer(managed.binaryPath, options);
    return { command: managed.binaryPath, args: [], version: managed.version };
  }
  for (const command of exports.executablesOnPath("rust-analyzer", options.env)) {
    try {
      return { command, args: [], version: await exports.probeServer(command, options) };
    } catch {
      // rustup installs a proxy even when the selected toolchain lacks the
      // rust-analyzer component. That proxy must not shadow a working server.
    }
  }
  const rustup = exports.executablesOnPath("rustup", options.env)[0];
  if (rustup) {
    try {
      const command = await exports.run(rustup, ["which", "rust-analyzer"], options);
      return { command, args: [], version: await exports.probeServer(command, options) };
    } catch {
      // An absent component is a missing server, not a startup failure.
    }
  }
  return null;
};

exports.latestServerVersion = async (api) => (await api.latestGithubRelease(REPOSITORY)).version;

exports.installServer = async ({ storagePath, api }, target = exports.currentTarget()) => {
  const assetName = exports.assetFor(target);
  if (!assetName)
    throw new Error(`rust-analyzer has no managed build for ${target.platform}/${target.arch}.`);
  api.setServerInstallationStatus("checking");
  const release = await api.latestGithubRelease(REPOSITORY);
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
