// Purpose: P1-2 — transparent local proxy between Codex and the ChatGPT backend. HTTP requests and WebSocket
// upgrades are forwarded byte for byte; only metadata is logged (never auth headers or conversation content).
// Input: [--port 17891]; the outbound proxy is taken from HTTPS_PROXY/HTTP_PROXY or the Windows proxy settings.
// Output: responses streamed back to Codex; one JSON line per request in local/proxy/<date>.jsonl.

import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import http, { type IncomingHttpHeaders } from "node:http";
import net from "node:net";
import { dirname, join, resolve } from "node:path";
import type { Duplex } from "node:stream";
import tls from "node:tls";
import { fileURLToPath, pathToFileURL } from "node:url";
import zlib from "node:zlib";

type Json = Record<string, any>;
const UPSTREAM_HOST = "chatgpt.com";
const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "te", "trailer", "upgrade", "host"]);
const localRoot = join(resolve(dirname(fileURLToPath(import.meta.url)), "../.."), "local");

// Outbound proxy: environment first, then the Windows per-user setting; NO_PROXY is honoured for the upstream host.
export function outboundProxy(env = process.env, windowsSetting = readWindowsProxy): { host: string; port: number } | null {
  const noProxy = (env.NO_PROXY ?? env.no_proxy ?? "").split(",").map((s) => s.trim().replace(/^\./, "")).filter(Boolean);
  if (noProxy.some((entry) => entry === "*" || UPSTREAM_HOST === entry || UPSTREAM_HOST.endsWith(`.${entry}`))) return null;
  const fromEnv = env.HTTPS_PROXY ?? env.https_proxy ?? env.HTTP_PROXY ?? env.http_proxy;
  let value = fromEnv || windowsSetting();
  if (!value) return null;
  // Windows may store per-protocol entries: "http=host:port;https=host:port".
  if (value.includes("=")) value = /https=([^;]+)/.exec(value)?.[1] ?? /http=([^;]+)/.exec(value)?.[1] ?? "";
  if (!value) return null;
  const url = new URL(/^[a-z]+:\/\//i.test(value) ? value : `http://${value}`);
  return { host: url.hostname, port: Number(url.port || 80) };
}

function readWindowsProxy(): string | null {
  if (process.platform !== "win32") return null;
  try {
    const out = execFileSync("reg", ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"], { encoding: "utf8" });
    if (!/ProxyEnable\s+REG_DWORD\s+0x1/.test(out)) return null;
    return /ProxyServer\s+REG_SZ\s+(\S+)/.exec(out)?.[1] ?? null;
  } catch {
    return null;
  }
}

function connectUpstream(via: { host: string; port: number } | null): Promise<tls.TLSSocket> {
  const startTls = (socket?: net.Socket) => new Promise<tls.TLSSocket>((ok, fail) => {
    const secure = tls.connect({ socket, host: socket ? undefined : UPSTREAM_HOST, port: 443, servername: UPSTREAM_HOST, ALPNProtocols: ["http/1.1"] }, () => ok(secure));
    secure.once("error", fail);
  });
  if (!via) return startTls();
  return new Promise((ok, fail) => {
    const socket = net.connect(via.port, via.host, () => socket.write(`CONNECT ${UPSTREAM_HOST}:443 HTTP/1.1\r\nHost: ${UPSTREAM_HOST}:443\r\n\r\n`));
    let buffered = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf("\r\n\r\n");
      if (end < 0) return;
      socket.off("data", onData);
      const status = buffered.toString("latin1", 0, end).split(" ")[1];
      if (status !== "200") { socket.destroy(); fail(new Error(`outbound proxy refused CONNECT (${status})`)); return; }
      startTls(socket).then(ok, fail);
    };
    socket.on("data", onData);
    socket.once("error", fail);
  });
}

function forwardHeaders(headers: IncomingHttpHeaders): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) if (value !== undefined && !HOP_BY_HOP.has(name)) out[name] = value;
  out.host = UPSTREAM_HOST;
  return out;
}

// Which task a request belongs to, from Codex's own turn metadata header.
export function requestIdentity(headers: IncomingHttpHeaders): { threadId: string | null; turnId: string | null; windowId: string | null } {
  let meta: Json = {};
  try { meta = JSON.parse(String(headers["x-codex-turn-metadata"] ?? "{}")); } catch { /* not JSON */ }
  return { threadId: meta.thread_id ?? meta.session_id ?? null, turnId: meta.turn_id ?? null, windowId: (headers["x-codex-window-id"] as string) ?? null };
}

function decodeBody(body: Buffer, encoding: string | undefined): Buffer | null {
  try {
    if (!encoding || encoding === "identity") return body;
    if (encoding === "zstd") return zlib.zstdDecompressSync(body);
    if (encoding === "gzip") return zlib.gunzipSync(body);
    if (encoding === "br") return zlib.brotliDecompressSync(body);
  } catch { /* fall through */ }
  return null;
}

// Metadata only: counts and sizes, never text or image content.
export function describeBody(path: string, json: Json): Json {
  if (/\/responses$/.test(path)) {
    const input: Json[] = Array.isArray(json.input) ? json.input : [];
    let images = 0;
    let imageBytes = 0;
    const visit = (value: unknown) => {
      if (Array.isArray(value)) return value.forEach(visit);
      if (!value || typeof value !== "object") return;
      const part = value as Json;
      if (part.type === "input_image" && typeof part.image_url === "string") { images++; imageBytes += part.image_url.length; }
      for (const child of Object.values(part)) if (typeof child === "object") visit(child);
    };
    visit(input);
    return { kind: "responses", model: json.model ?? null, inputItems: input.length, images, imageBytes, stream: json.stream ?? null, promptCacheKey: json.prompt_cache_key ?? null };
  }
  if (/\/images\/(generations|edits)$/.test(path)) {
    const inputs = Array.isArray(json.images) ? json.images : json.image ? [json.image] : [];
    return { kind: path.endsWith("edits") ? "image_edit" : "image_generation", model: json.model ?? null, inputImages: inputs.length, size: json.size ?? null };
  }
  return { kind: "other" };
}

function log(entry: Json): void {
  mkdirSync(join(localRoot, "proxy"), { recursive: true });
  appendFileSync(join(localRoot, "proxy", `${new Date().toISOString().slice(0, 10)}.jsonl`), `${JSON.stringify(entry)}\n`);
}

function main(): void {
  const portIndex = process.argv.indexOf("--port");
  const port = Number(portIndex >= 0 ? process.argv[portIndex + 1] : 17891);
  const via = outboundProxy();
  let sequence = 0;

  const onRequest = (req: http.IncomingMessage, res: http.ServerResponse) => {
    if (req.url === "/__cam/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, upstream: UPSTREAM_HOST, via: via ? `${via.host}:${via.port}` : "direct" }));
      return;
    }
    const id = ++sequence;
    const started = Date.now();
    const path = (req.url ?? "/").split("?")[0];
    const chunks: Buffer[] = [];
    let requestBytes = 0;
    let responseBytes = 0;
    let status = 0;
    let finished = false;
    const finish = (error?: string) => {
      if (finished) return;
      finished = true;
      const body = Buffer.concat(chunks);
      const decoded = req.method === "POST" ? decodeBody(body, req.headers["content-encoding"] as string | undefined) : null;
      let details: Json = {};
      if (decoded) { try { details = describeBody(path, JSON.parse(decoded.toString("utf8"))); } catch { details = { kind: "unparsed" }; } }
      log({ at: new Date(started).toISOString(), id, transport: "http", method: req.method, path, status, requestBytes, decodedBytes: decoded?.length ?? null, contentEncoding: req.headers["content-encoding"] ?? null, responseBytes, ms: Date.now() - started, ...requestIdentity(req.headers), ...details, error: error ?? null });
    };
    connectUpstream(via).then((socket) => {
      // No `agent` option: with agent:false Node ignores createConnection and dials the host directly.
      const upstream = http.request({ host: UPSTREAM_HOST, method: req.method, path: req.url, headers: forwardHeaders(req.headers), createConnection: () => socket }, (answer) => {
        status = answer.statusCode ?? 0;
        const headers: Record<string, string | string[]> = {};
        for (const [name, value] of Object.entries(answer.headers)) if (value !== undefined && !HOP_BY_HOP.has(name)) headers[name] = value;
        res.writeHead(status, headers);
        answer.on("data", (chunk: Buffer) => { responseBytes += chunk.length; });
        answer.pipe(res);
        answer.on("end", () => finish());
        answer.on("error", (error) => finish(String(error)));
      });
      upstream.on("error", (error) => { if (!res.headersSent) res.writeHead(502); res.end(); finish(String(error)); });
      // Codex may drop the connection mid-stream; still log the request once.
      res.on("close", () => finish(res.writableFinished ? undefined : "client closed before the response ended"));
      req.on("data", (chunk: Buffer) => { chunks.push(chunk); requestBytes += chunk.length; });
      req.pipe(upstream);
    }, (error) => {
      res.writeHead(502, { "content-type": "text/plain" });
      res.end(`codex-attachment-manager proxy: cannot reach ${UPSTREAM_HOST}`);
      finish(String(error));
    });
  };

  const onUpgrade = (req: http.IncomingMessage, client: Duplex, head: Buffer) => {
    const id = ++sequence;
    const started = Date.now();
    let up = head.length;
    let down = 0;
    let upstreamStatus: string | null = null;
    connectUpstream(via).then((socket) => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const name = req.rawHeaders[i];
        lines.push(`${name}: ${name.toLowerCase() === "host" ? UPSTREAM_HOST : req.rawHeaders[i + 1]}`);
      }
      socket.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head.length) socket.write(head);
      socket.once("data", (chunk: Buffer) => { upstreamStatus = chunk.toString("latin1", 0, Math.min(chunk.length, 40)).split("\r\n")[0]; });
      socket.on("data", (chunk: Buffer) => { down += chunk.length; });
      client.on("data", (chunk: Buffer) => { up += chunk.length; });
      socket.pipe(client);
      client.pipe(socket);
      let logged = false;
      const close = () => {
        if (logged) return;
        logged = true;
        socket.destroy();
        client.destroy();
        log({ at: new Date(started).toISOString(), id, transport: "websocket", path: (req.url ?? "/").split("?")[0], upstreamStatus, upBytes: up, downBytes: down, ms: Date.now() - started, ...requestIdentity(req.headers) });
      };
      socket.on("close", close);
      client.on("close", close);
      socket.on("error", close);
      client.on("error", close);
    }, (error) => {
      client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      log({ at: new Date(started).toISOString(), id, transport: "websocket", path: req.url, error: String(error), ...requestIdentity(req.headers) });
    });
  };

  // Codex may resolve "localhost" to either loopback address, so listen on both (and only on loopback).
  for (const host of ["127.0.0.1", "::1"]) {
    const server = http.createServer(onRequest);
    server.on("upgrade", onUpgrade);
    server.requestTimeout = 0;
    server.on("error", (error) => console.error(JSON.stringify({ host, error: String(error) })));
    server.listen(port, host, () => {
      console.log(JSON.stringify({ listening: `http://${host.includes(":") ? `[${host}]` : host}:${port}/backend-api/codex`, upstream: UPSTREAM_HOST, via: via ? `${via.host}:${via.port}` : "direct" }));
    });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
