// Userinfo strip (A4.5 SEC-2 / A4.7 R-SEC-4). The single chokepoint for any
// URL persisted in the packet. Inline parsing is forbidden elsewhere.

export function stripUserinfo(url: string): string {
  if (!url) return url;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (parsed.username || parsed.password) {
    parsed.username = "";
    parsed.password = "";
  }
  return parsed.toString();
}

export function parseRemoteToOwnerRepo(remoteUrl: string): string {
  if (!remoteUrl) return "";
  // SSH form: git@host:owner/repo[.git]
  const ssh = /^[^@]+@[^:]+:(?<path>[^\s]+?)(?:\.git)?\/?$/.exec(remoteUrl);
  if (ssh?.groups?.path) return ssh.groups.path;
  // HTTPS form: scheme://host/owner/repo[.git]
  const stripped = stripUserinfo(remoteUrl);
  let parsed: URL;
  try {
    parsed = new URL(stripped);
  } catch {
    return "";
  }
  if (!parsed.protocol || !parsed.pathname) return "";
  let path = parsed.pathname.replace(/^\//, "");
  if (path.endsWith(".git")) path = path.slice(0, -4);
  return path.replace(/\/+$/, "");
}
