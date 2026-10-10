// The session state the Claude plugin's mod keeps (hooks/register.js): whether it pointed this Claude Code process at
// the engine, and what to put back when it stops. Read by `claude plugin validate`.
export type RoutingState = {
  active: boolean;
  port: number | null;
  originalBaseUrl: string | null;
  originalNoProxy: string | null;
  originalNoProxyLower: string | null;
  reason: string | null;
} | null;

declare module "claude-code" {
  interface PluginState {
    "codex-attachment-manager": { routing: RoutingState };
  }
}
