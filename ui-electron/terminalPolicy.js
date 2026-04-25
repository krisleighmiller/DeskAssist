const path = require("path");

function isPathWithinRoot(child, root) {
  return child === root || child.startsWith(`${root}${path.sep}`);
}

function allowedTerminalRoots({
  activeCasefileRoot,
  activeLaneRoot,
  registeredLaneRoots,
  realpathIfDirectory,
}) {
  const roots = new Set();
  for (const root of [
    activeCasefileRoot,
    activeLaneRoot,
    ...(Array.isArray(registeredLaneRoots) ? registeredLaneRoots : []),
  ]) {
    const real = root ? realpathIfDirectory(root) : null;
    if (real) roots.add(real);
  }
  return Array.from(roots);
}

function resolveAllowedTerminalCwd({
  requestedCwd,
  activeCasefileRoot,
  activeLaneRoot,
  registeredLaneRoots,
  realpathIfDirectory,
  homeDir,
}) {
  if (!activeCasefileRoot) {
    return realpathIfDirectory(requestedCwd) || homeDir;
  }
  const allowedRoots = allowedTerminalRoots({
    activeCasefileRoot,
    activeLaneRoot,
    registeredLaneRoots,
    realpathIfDirectory,
  });
  const fallback = realpathIfDirectory(activeLaneRoot) || allowedRoots[0];
  if (!fallback) {
    throw new Error("No valid workspace root is available for terminal startup");
  }
  const requested = realpathIfDirectory(requestedCwd);
  if (!requested) return fallback;
  if (allowedRoots.some((root) => isPathWithinRoot(requested, root))) {
    return requested;
  }
  return fallback;
}

module.exports = {
  allowedTerminalRoots,
  isPathWithinRoot,
  resolveAllowedTerminalCwd,
};
