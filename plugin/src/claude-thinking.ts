// Purpose: v0.4 — keep the thinking in a Claude Code request valid when the engine has changed the history before it.
// Anthropic binds each thinking block to everything before it in the conversation (Fable 5.1, Opus 5.5, Sonnet 5.5,
// Haiku 5.5); accounts created from 2026-08-31 refuse a request whose thinking no longer matches, older ones let it
// through (docs/v0.4/plan.md §2). Thinking may be left out, as long as each block kept comes after exactly what it was
// made after. So the engine remembers, per session, what it sent for each history it saw (as hash chains), and keeps a
// thinking block only when what comes before it now is what was sent when the block was made.
// Input: a request's messages as Claude Code built them and as the engine will send them; the session's record.
// Output: the messages without the thinking that no longer fits, counts, and the chains to remember;
// <data dir>/claude/thinking/<session>.json (whether the account refuses such thinking, and hashes; never content).

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claudeThinkingDirOf } from "./paths.ts";

type Json = Record<string, any>;
const THINKING = new Set(["thinking", "redacted_thinking"]);
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Hashes of the latest histories only: a block is made after the history of the request just before it.
const KEEP = 2000;

// What Anthropic compares: values, not JSON formatting or key order; content given as a string is the text block it
// stands for (Claude Code sends its trailing system message as a block with a cache breakpoint, and as a string in the
// requests after); cache breakpoints move from request to request.
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  const out: Json = {};
  for (const key of Object.keys(value).sort()) {
    const field = (value as Json)[key];
    if (key === "cache_control") continue;
    out[key] = key === "content" && typeof field === "string" ? [{ text: field, type: "text" }] : canonical(field);
  }
  return out;
}
export const link = (previous: string, message: Json): string =>
  createHash("sha256").update(previous).update("\n").update(JSON.stringify(canonical(message)) ?? "").digest("hex");
export const chainOf = (messages: Json[]): string => messages.reduce((chain: string, message) => link(chain, message), "");

const thinkingIn = (message: Json): number =>
  message?.role === "assistant" && Array.isArray(message.content) ? message.content.filter((block: Json) => THINKING.has(block?.type)).length : 0;

export type ThinkingFit = { messages: Json[]; kept: number; left: number; history: string; sent: string };

// sent: for each history the engine changed, the chain of what it sent instead. A history it never changed went out as
// it was. The rewrite never adds, drops or edits an assistant message, so the n-th one of each list is the same.
export function fitThinking(original: Json[], outgoing: Json[], sent: ReadonlyMap<string, string>): ThinkingFit {
  const madeAfter: string[] = [];
  let history = "";
  for (const message of original) {
    if (message?.role === "assistant") madeAfter.push(history);
    history = link(history, message);
  }
  let chain = "";
  let assistant = 0;
  let kept = 0;
  let left = 0;
  const messages = outgoing.map((message) => {
    let next = message;
    if (message?.role === "assistant") {
      const made = madeAfter[assistant++];
      const count = thinkingIn(message);
      if (count) {
        const rest = message.content.filter((block: Json) => !THINKING.has(block?.type));
        // A message of thinking alone stays: Anthropic takes no empty message (the request may then be refused).
        if (made === undefined || (sent.get(made) ?? made) === chain || !rest.length) kept += count;
        else {
          left += count;
          next = { ...message, content: rest };
        }
      }
    }
    chain = link(chain, next);
    return next;
  });
  return { messages, kept, left, history, sent: chain };
}

// strict: Anthropic refused this session's thinking after an edited history once (the account checks it).
export type ThinkingRecord = { strict: boolean; sent: Map<string, string> };

export function readThinkingRecord(sessionId: string, dir = claudeThinkingDirOf()): ThinkingRecord {
  const empty: ThinkingRecord = { strict: false, sent: new Map() };
  if (!SESSION_ID.test(sessionId)) return empty;
  const file = join(dir, `${sessionId}.json`);
  if (!existsSync(file)) return empty;
  try {
    const json = JSON.parse(readFileSync(file, "utf8"));
    const pairs = Array.isArray(json.sent) ? json.sent.filter((pair: unknown) => Array.isArray(pair) && pair.length === 2 && pair.every((hash) => typeof hash === "string")) : [];
    return { strict: json.strict === true, sent: new Map(pairs) };
  } catch {
    return empty;
  }
}

export function writeThinkingRecord(sessionId: string, record: ThinkingRecord, dir = claudeThinkingDirOf()): void {
  if (!SESSION_ID.test(sessionId)) return;
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${sessionId}.json`);
  writeFileSync(`${file}.tmp`, JSON.stringify({ strict: record.strict, sent: [...record.sent] }));
  renameSync(`${file}.tmp`, file);
}

// What went out for a history: a changed one is remembered (latest last), one sent as it was needs no entry.
export function rememberSent(record: ThinkingRecord, history: string, sent: string): void {
  record.sent.delete(history);
  if (sent !== history) record.sent.set(history, sent);
  for (const key of record.sent.keys()) {
    if (record.sent.size <= KEEP) break;
    record.sent.delete(key);
  }
}
