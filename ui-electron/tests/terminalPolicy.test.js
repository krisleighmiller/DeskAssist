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
    activeContextRoot: "/case/context",
    registeredContextRoots: ["/case/context"],
    realpathIfDirectory: makeRealpath({
      "/case": "/real/case",
      "/case/context": "/real/case/context",
      "/tmp": "/tmp",
    }),
    homeDir: "/home/user",
  });

  assert.equal(cwd, "/real/case/context");
});

test("terminal cwd accepts registered context roots outside casefile", () => {
  const cwd = resolveAllowedTerminalCwd({
    requestedCwd: "/external/context/subdir",
    activeCasefileRoot: "/case",
    activeContextRoot: "/case/main",
    registeredContextRoots: ["/external/context"],
    realpathIfDirectory: makeRealpath({
      "/case": "/real/case",
      "/case/main": "/real/case/main",
      "/external/context": "/external/context",
      "/external/context/subdir": "/external/context/subdir",
    }),
    homeDir: "/home/user",
  });

  assert.equal(cwd, "/external/context/subdir");
});

test("terminal cwd fails when an open workspace has no valid roots", () => {
  assert.throws(
    () =>
      resolveAllowedTerminalCwd({
        requestedCwd: "/tmp",
        activeCasefileRoot: "/missing/case",
        activeContextRoot: "/missing/context",
        registeredContextRoots: [],
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
    activeContextRoot: null,
    registeredContextRoots: [],
    realpathIfDirectory: makeRealpath({}),
    homeDir: "/home/user",
  });

  assert.equal(cwd, "/home/user");
});
