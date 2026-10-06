const server = require("./server");

const setting = (name) => lumine.config.get(`ide-rust.${name}`);
const booleanOverride = (name) => {
  const value = setting(name);
  return value === "enabled" ? true : value === "disabled" ? false : undefined;
};
const compact = (value) =>
  Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) => {
      if (item === undefined) return [];
      if (item && typeof item === "object" && !Array.isArray(item)) {
        const nested = compact(item);
        return Object.keys(nested).length ? [[key, nested]] : [];
      }
      return [[key, item]];
    }),
  );

const options = () =>
  compact({
    checkOnSave: booleanOverride("checkOnSave"),
    check: {
      command: setting("checkCommand") === "server-default" ? undefined : setting("checkCommand"),
    },
    cargo: {
      features: setting("allFeatures")
        ? "all"
        : setting("cargoFeatures")?.length
          ? setting("cargoFeatures")
          : undefined,
      target: setting("cargoTarget") || undefined,
      allTargets: booleanOverride("allTargets"),
      buildScripts: { enable: booleanOverride("buildScripts") },
    },
    procMacro: { enable: booleanOverride("procMacros") },
    inlayHints: {
      typeHints: { enable: booleanOverride("typeHints") },
      parameterHints: { enable: booleanOverride("parameterHints") },
    },
  });

module.exports = {
  consumeIde(client) {
    return client.registerAdapter({
      id: "ide-rust",
      displayName: "rust-analyzer",
      grammarScopes: ["source.rust"],
      languageId: "rust",
      sessionScope: "project-root",
      settingsKeyPaths: ["ide-rust"],
      restartKeyPaths: ["ide-rust.serverPath", "ide-rust.toolchain"],
      managedServerDisplayName: "rust-analyzer",
      // rust-analyzer's lenses are client commands, not executeCommand
      // requests. The hub cannot execute them yet.
      isFeatureAvailable: (feature) => feature !== "codeLens",
      installServer: server.installServer,
      latestServerVersion: server.latestServerVersion,
      async resolveServer(context) {
        const env = server.rustEnvironment(setting("toolchain"));
        const launch = await server.resolveServer(context, setting("serverPath"), {
          cwd: context.rootPath,
          env: { ...process.env, ...env },
        });
        if (!launch) {
          client.reportMissingServer("ide-rust", {
            description:
              "Install rust-analyzer through Manage Servers, or add the rustup component with `rustup component add rust-analyzer`. A Rust toolchain is needed for project analysis; install `rust-src` and `rustfmt` for standard-library navigation and formatting.",
          });
          return null;
        }
        return { ...launch, cwd: context.rootPath, env, transport: "stdio" };
      },
      getInitializationOptions: options,
      getSettings: () => ({ "rust-analyzer": options() }),
    });
  },
  provideBackgroundTips() {
    return {
      packageName: "ide-rust",
      tips: [
        "Rust projects get completion, navigation and refactorings from rust-analyzer. Add the rust-src component to your Rust toolchain to navigate into the standard library.",
      ],
    };
  },
};
