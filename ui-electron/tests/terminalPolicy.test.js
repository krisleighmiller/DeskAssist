const assert = require("node:assert/strict");
const test = require("node:test");

const { resolveAllowedTerminalCwd } = require("../terminalPolicy");

function makeRealpath(existing) {
  const map = new Map(Object.entries(existing));
  return (candidate) => (candidate ? map.get(candidate) || null : null);
}

test("terminal cwd falls back inside workspace when requested path is outside", () => {
  const cwd = resolveAllowedTerminalCwd({
    requestedCwd: "/tmp",
    activeCasefileRoot: "/case",
    activeLaneRoot: "/case/lane",
    registeredLaneRoots: ["/case/lane"],
    realpathIfDirectory: makeRealpath({
      "/case": "/real/case",
      "/case/lane": "/real/case/lane",
      "/tmp": "/tmp",
    }),
    homeDir: "/home/user",
  });

  assert.equal(cwd, "/real/case/lane");
});

test("terminal cwd accepts registered lane roots outside casefile", () => {
  const cwd = resolveAllowedTerminalCwd({
    requestedCwd: "/external/lane/subdir",
    activeCasefileRoot: "/case",
    activeLaneRoot: "/case/main",
    registeredLaneRoots: ["/external/lane"],
    realpathIfDirectory: makeRealpath({
      "/case": "/real/case",
      "/case/main": "/real/case/main",
      "/external/lane": "/external/lane",
      "/external/lane/subdir": "/external/lane/subdir",
    }),
    homeDir: "/home/user",
  });

  assert.equal(cwd, "/external/lane/subdir");
});

test("terminal cwd fails when an open workspace has no valid roots", () => {
  assert.throws(
    () =>
      resolveAllowedTerminalCwd({
        requestedCwd: "/tmp",
        activeCasefileRoot: "/missing/case",
        activeLaneRoot: "/missing/lane",
        registeredLaneRoots: [],
        realpathIfDirectory: makeRealpath({ "/tmp": "/tmp" }),
        homeDir: "/home/user",
      }),
    /No valid workspace root/
  );
});

test("terminal cwd may use home only when no casefile is open", () => {
  const cwd = resolveAllowedTerminalCwd({
    requestedCwd: "/missing",
    activeCasefileRoot: null,
    activeLaneRoot: null,
    registeredLaneRoots: [],
    realpathIfDirectory: makeRealpath({}),
    homeDir: "/home/user",
  });

  assert.equal(cwd, "/home/user");
});
