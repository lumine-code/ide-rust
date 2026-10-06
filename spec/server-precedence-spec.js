const { serverContext } = require("./helpers/server-resolver");

describe("ide-rust managed source precedence", () => {
  it("uses an explicit server without reading a damaged managed installation", async () => {
    const server = require("../lib/server");
    spyOn(server, "probeServer").and.resolveTo("test-version");
    const getManagedServer = jasmine
      .createSpy("managed installation")
      .and.throwError("Damaged installation");
    const launch = await server.resolveServer(
      serverContext({ getManagedServer }),
      process.execPath,
    );
    expect(launch.command).toBe(process.execPath);
    expect(getManagedServer).not.toHaveBeenCalled();
  });

  it("reports a damaged managed installation before falling back to discovery", async () => {
    const server = require("../lib/server");
    const getManagedServer = jasmine
      .createSpy("managed installation")
      .and.throwError("Damaged installation");
    await expectAsync(
      server.resolveServer(serverContext({ getManagedServer })),
    ).toBeRejectedWithError("Damaged installation");
    expect(getManagedServer).toHaveBeenCalledTimes(1);
  });
});
