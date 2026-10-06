const path = require("node:path");
const { createServerResolver } = require(
  path.join(lumine.packages.resolvePackagePath("ide"), "lib", "server-resolver"),
);

exports.resolver = { ...createServerResolver() };
exports.createServerResolver = createServerResolver;
exports.serverContext = ({ managedServer = null, getManagedServer, ...overrides } = {}) => {
  let settled = false;
  let installed, failure;
  let failed = false;
  return {
    rootPath: __dirname,
    resolver: exports.resolver,
    ...overrides,
    getManagedServer() {
      if (!settled) {
        settled = true;
        try {
          installed = getManagedServer ? getManagedServer() : managedServer;
        } catch (error) {
          failed = true;
          failure = error;
        }
      }
      if (failed) throw failure;
      return installed;
    },
  };
};
exports.serverApi = (api = {}) => ({ resolver: createServerResolver(), ...api });
exports.installContext = (context) => ({ ...context, api: exports.serverApi(context.api) });
exports.findOnPath = (name, env = process.env, platform = process.platform) =>
  createServerResolver().findExecutables(name, { env, platform })[0] || null;
