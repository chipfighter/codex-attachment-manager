// Purpose: minimal JSON-RPC client for `codex app-server` over stdio, used by the phase 0 scripts.
// Input: the desktop-bundled codex.exe (auto-detected) plus optional CLI args and env.
// Output: request/notification API; the server's stderr is appended to a log file under local/.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createWriteStream, existsSync, readdirSync, statSync, type WriteStream } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

type Json = Record<string, any>;
export type Notification = { method: string; params: Json };
type Pending = { resolve: (value: any) => void; reject: (error: Error) => void; method: string; timer: NodeJS.Timeout };
type ServerRequestHandler = (method: string, params: Json) => Json | undefined;

// Approval-style server requests are declined so a test turn can never change files or permissions.
const DECLINE: Record<string, Json> = {
  "item/commandExecution/requestApproval": { decision: "decline" },
  "item/fileChange/requestApproval": { decision: "decline" },
  execCommandApproval: { decision: "denied" },
  applyPatchApproval: { decision: "denied" },
};

export function findBundledCodex(): string {
  const bin = join(process.env.LOCALAPPDATA ?? "", "OpenAI", "Codex", "bin");
  if (!existsSync(bin)) throw new Error("desktop-bundled codex not found under %LOCALAPPDATA%\\OpenAI\\Codex\\bin");
  const candidates = readdirSync(bin)
    .map((name) => join(bin, name, "codex.exe"))
    .filter((file) => existsSync(file))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  if (!candidates.length) throw new Error("no codex.exe in the desktop bin directory");
  return candidates[0];
}

export class AppServer {
  readonly notifications: Notification[] = [];
  #child: ChildProcessWithoutNullStreams;
  #log: WriteStream;
  #nextId = 1;
  #pending = new Map<number, Pending>();
  #listeners = new Set<(notification: Notification) => void>();
  #onServerRequest: ServerRequestHandler | undefined;
  #exited: Promise<number | null>;

  // `env` overrides the inherited environment; an undefined value removes that variable.
  constructor(codexPath: string, args: string[], env: Record<string, string | undefined>, stderrLog: string, onServerRequest?: ServerRequestHandler) {
    this.#log = createWriteStream(stderrLog, { flags: "a" });
    this.#onServerRequest = onServerRequest;
    const childEnv: Record<string, string | undefined> = { ...process.env, ...env };
    for (const [name, value] of Object.entries(childEnv)) if (value === undefined) delete childEnv[name];
    this.#child = spawn(codexPath, ["app-server", ...args], { env: childEnv, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.#child.stderr.pipe(this.#log);
    this.#exited = new Promise((resolve) => this.#child.on("exit", (code) => resolve(code)));
    this.#child.on("exit", (code) => {
      for (const pending of this.#pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`app-server exited (${code}) while waiting for ${pending.method}`));
      }
      this.#pending.clear();
    });
    createInterface({ input: this.#child.stdout, crlfDelay: Infinity }).on("line", (line) => this.#dispatch(line));
  }

  #write(message: Json): void {
    this.#child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #dispatch(line: string): void {
    if (!line.trim()) return;
    let message: Json;
    try { message = JSON.parse(line); }
    catch { this.#log.write(`[client] unparsable stdout line (${line.length} chars)\n`); return; }
    if (message.id !== undefined && message.method === undefined) {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message ?? JSON.stringify(message.error)}`));
      else pending.resolve(message.result);
      return;
    }
    if (message.id !== undefined) {
      const custom = this.#onServerRequest?.(message.method, message.params ?? {});
      const result = custom ?? DECLINE[message.method];
      this.#log.write(`[client] server request ${message.method} -> ${result ? "answered" : "rejected"}\n`);
      if (result) this.#write({ id: message.id, result });
      else this.#write({ id: message.id, error: { code: -32601, message: `phase 0 client does not handle ${message.method}` } });
      return;
    }
    const notification: Notification = { method: message.method, params: message.params ?? {} };
    this.notifications.push(notification);
    for (const listener of this.#listeners) listener(notification);
  }

  request<T = Json>(method: string, params: unknown, timeoutMs = 120_000): Promise<T> {
    const id = this.#nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, method, timer });
      this.#write({ id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    this.#write(params === undefined ? { method } : { method, params });
  }

  waitFor(predicate: (notification: Notification) => boolean, timeoutMs: number): Promise<Notification> {
    const already = this.notifications.find(predicate);
    if (already) return Promise.resolve(already);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.#listeners.delete(listener); reject(new Error(`notification wait timed out after ${timeoutMs} ms`)); }, timeoutMs);
      const listener = (notification: Notification) => {
        if (!predicate(notification)) return;
        clearTimeout(timer);
        this.#listeners.delete(listener);
        resolve(notification);
      };
      this.#listeners.add(listener);
    });
  }

  async initialize(): Promise<Json> {
    const result = await this.request("initialize", {
      clientInfo: { name: "codex-attachment-manager-phase0", title: "Codex Attachment Manager (phase 0)", version: "0.0.0" },
      capabilities: null,
    });
    this.notify("initialized");
    return result;
  }

  async stop(timeoutMs = 10_000): Promise<number | null> {
    this.#child.stdin.end();
    const timer = setTimeout(() => this.#child.kill(), timeoutMs);
    const code = await this.#exited;
    clearTimeout(timer);
    await new Promise<void>((resolve) => this.#log.end(() => resolve()));
    return code;
  }
}
