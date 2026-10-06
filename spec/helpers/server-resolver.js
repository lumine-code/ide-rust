const path = require("node:path");
const { createServerResolver } = require(
  path.join(lumine.packages.resolvePackagePath("ide-client"), "lib", "server-resolver"),
);

exports.resolver = { ...createServerResolver() };
exports.createServerResolver = createServerResolver;
exports.serverContext = (overrides = {}) => ({
  rootPath: __dirname,
  resolver: exports.resolver,
  ...overrides,
});
exports.serverApi = (api = {}) => ({ resolver: createServerResolver(), ...api });
exports.installContext = (context) => ({ ...context, api: exports.serverApi(context.api) });
exports.findOnPath = (name, env = process.env, platform = process.platform) =>
  createServerResolver().findExecutables(name, { env, platform })[0] || null;
