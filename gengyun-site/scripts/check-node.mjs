// Match the starter's supported engine before copying, installing or building.
export function checkNode(version = process.versions.node) {
  const [major, minor] = version.split('.').map(Number);
  if (!((major === 22 && minor >= 13) || major >= 24)) {
    throw new Error(`This starter requires Node 22.13+ in the 22.x series or Node 24+; current Node is ${version}. Select a compatible installed runtime for this terminal, then retry. Keep that PATH for install, dev and build.`);
  }
}
checkNode();
