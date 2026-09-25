// Purpose: P2 — replace the images the user unchecked with placeholder text in a Responses request's `input`.
// Nothing else changes: checked images, unknown images and all other items are forwarded as they are.
// v0.1 — placeholders say the image was seen when it appeared and is left out now by the user's choice, so the model
// keeps trusting what it said about it (user report 2026-09-25).
// v0.1-14 — in the user's language (Codex's interface language, language.ts): the Chinese wording is the one tested on
// 2026-09-25; the English one says the same and is checked by the same self-test (v01-placeholder-selftest.ts --lang en).
// Input: request items, a lookup into the thread index, the unchecked keys. Output: new items plus a metadata report.

import { findImages, type ImageKind, type ImageRef } from "./images.ts";
import type { Lang } from "./language.ts";

type Json = Record<string, any>;
export type Described = { id: string; name: string | null; label: string | null; kind: ImageKind; turn: number | null; width: number | null; height: number | null };
export type Replacement = { id: string; key: string; kind: ImageKind; mode: "plain" | "duplicate"; sameAs: string | null; base64Chars: number };
// noteAt: where the developer message explaining omitted images was inserted, if one was.
export type RewriteReport = { images: number; replaced: Replacement[]; locked: string[]; sentContentIds: string[]; noteAt?: number };

type Words = {
  kind: Record<ImageKind, string>; unnamed: string; turn: (n: number) => string; thisTurn: string; newImage: string;
  omitted: string; notRepeated: string; separator: string;
  heading: (id: string, label: string | null, state: string, fields: string[]) => string;
  plain: (id: string) => string; duplicate: (id: string, where: string) => string; note: string;
};

// The image sits in the history, so the model concludes it never saw it and takes back what it said about it (user
// report 2026-09-25). Saying otherwise inside the placeholder did not help: it is user content, which the model does
// not take as proof. So the explanation goes once into a developer message, before the turn where the first omitted
// image appeared, and each placeholder only points to it.
const WORDS: Record<Lang, Words> = {
  zh: {
    kind: { upload: "用户上传", view: "工具查看的图片", generated: "生成的图片", tool: "工具结果里的图片" },
    unnamed: "未命名",
    turn: (n) => `第 ${n} 轮`,
    thisTurn: "本轮",
    newImage: "（新图片）",
    omitted: "已省略",
    notRepeated: "未重复提供",
    separator: "，",
    heading: (id, label, state, fields) => `[图片 ${id}${label ? `（${label}）` : ""} ${state}｜${fields.join("｜")}]`,
    plain: (id) => `原图被用户省略以节省上下文，情况见前面的“上下文管理说明”；需要重新看这张图时，在回复里写出“需要 ${id}”。`,
    duplicate: (id, where) => `这张图和 ${id}（${where}）内容完全相同，那一条在本次请求里照常提供，请直接参考那一条。`,
    note: [
      "上下文管理说明（来自用户安装的上下文素材管理工具）：为了节省上下文，用户取消勾选了这个任务里的部分图片。后面的对话里，这些图片原来的位置被换成了“[图片 IMG-xxx 已省略…]”这样的占位文字。",
      "这些图片在它们出现的那一轮真实存在，你当时收到并看过；你之前对它们的描述，以及据此做出的判断，都是看着原图做出的，仍然有效。不要因为现在看不到，就认为之前的回答是猜测或错误，也不要收回或道歉。",
      "被问到现在能不能看到时，如实说明现在看不到（被用户省略了），并说明之前的描述仍然有效。现在看不到画面，就不要补充之前没说过的细节；需要重新看某张图时，在回复里写出“需要 IMG-xxx”，用户可以重新勾选；不要自己用工具去读取这些图片。",
    ].join("\n"),
  },
  en: {
    kind: { upload: "uploaded by the user", view: "viewed with a tool", generated: "generated image", tool: "image from a tool result" },
    unnamed: "unnamed",
    turn: (n) => `turn ${n}`,
    thisTurn: "this turn",
    newImage: "(new image)",
    omitted: "omitted",
    notRepeated: "not repeated",
    separator: ", ",
    heading: (id, label, state, fields) => `[Image ${id}${label ? ` (${label})` : ""} ${state} | ${fields.join(" | ")}]`,
    plain: (id) => `The user left out the original image to save context; see the "Context management note" above. If you need to see this image again, write "need ${id}" in your reply.`,
    duplicate: (id, where) => `This image is identical to ${id} (${where}), which is included in this request as usual; refer to that one.`,
    note: [
      "Context management note (from the context asset manager the user installed): to save context, the user unchecked some images in this task. Further on in the conversation, where those images were, there is now placeholder text such as \"[Image IMG-xxx omitted…]\".",
      "These images really existed in the turn where they appeared, and you received and looked at them then; what you said about them before, and the judgments you based on it, were made looking at the original images and remain valid. Do not treat your earlier answers as guesses or mistakes because you cannot see the images now, and do not take them back or apologize.",
      "If asked whether you can see them now, say truthfully that you cannot see them now (the user left them out), and that your earlier descriptions remain valid. Since you cannot see them now, do not add details you did not mention before; if you need to look at an image again, write \"need IMG-xxx\" in your reply, and the user can check it again; do not read these images yourself with tools.",
    ].join("\n"),
  },
};

// Kept for the tests and the 2026-09-25 record: the Chinese note as tested then.
export const OMISSION_NOTE = WORDS.zh.note;
export const omissionNote = (lang: Lang) => WORDS[lang].note;

function heading(words: Words, image: Described, state: string): string {
  const fields = [image.name ?? words.unnamed, words.kind[image.kind]];
  if (image.turn !== null) fields.push(words.turn(image.turn));
  if (image.width && image.height) fields.push(`${image.width}×${image.height}`);
  return words.heading(image.id, image.label, state, fields);
}

export function plainPlaceholder(image: Described, lang: Lang = "zh"): string {
  const words = WORDS[lang];
  return `${heading(words, image, words.omitted)}\n${words.plain(image.id)}`;
}

export function duplicatePlaceholder(image: Described, same: Described, lang: Lang = "zh"): string {
  const words = WORDS[lang];
  const where = [same.name, same.turn !== null ? words.turn(same.turn) : words.thisTurn].filter(Boolean).join(words.separator);
  return `${heading(words, image, words.notRepeated)}\n${words.duplicate(same.id, where)}`;
}

export function rewriteItems(
  items: Json[],
  describe: (ref: ImageRef) => Described | undefined,
  unchecked: Set<string>,
  pixelHash: (ref: ImageRef) => string | null,
  lang: Lang = "zh",
): { items: Json[]; report: RewriteReport } {
  const refs = findImages(items);
  const report: RewriteReport = { images: refs.length, replaced: [], locked: [], sentContentIds: [] };
  const drop = refs.filter((ref) => unchecked.has(ref.key) && ref.replaceable && describe(ref));
  for (const ref of refs) if (unchecked.has(ref.key) && !ref.replaceable) report.locked.push(describe(ref)?.id ?? ref.key);
  const sent = refs.filter((ref) => !drop.includes(ref));
  report.sentContentIds = sent.map((ref) => ref.contentId);
  if (!drop.length) return { items, report };

  const same = (a: ImageRef, b: ImageRef) => {
    if (a.contentId === b.contentId) return true;
    if (a.width !== b.width || a.height !== b.height) return false;
    const pixels = pixelHash(a);
    return pixels !== null && pixels === pixelHash(b);
  };
  const edits = new Map<number, Array<{ from: number; to: number; text: string }>>();
  let firstPlain: number | null = null;
  for (const ref of drop) {
    const image = describe(ref)!;
    const copy = sent.find((other) => same(other, ref));
    const copyImage = copy ? describe(copy) ?? { id: WORDS[lang].newImage, name: copy.name, label: copy.label, kind: copy.kind, turn: null, width: copy.width, height: copy.height } : null;
    const text = copyImage ? duplicatePlaceholder(image, copyImage, lang) : plainPlaceholder(image, lang);
    if (!copyImage && firstPlain === null) firstPlain = ref.item;
    report.replaced.push({ id: image.id, key: ref.key, kind: ref.kind, mode: copyImage ? "duplicate" : "plain", sameAs: copyImage?.id ?? null, base64Chars: ref.base64Chars });
    const list = edits.get(ref.item) ?? [];
    list.push({ from: ref.openTag ?? ref.part!, to: ref.closeTag ?? ref.part!, text });
    edits.set(ref.item, list);
  }
  const next = items.map((item, index) => {
    const list = edits.get(index);
    if (!list) return item;
    const field = item.type === "message" ? "content" : "output";
    const parts: Json[] = [...item[field]];
    for (const edit of list.sort((a, b) => b.from - a.from)) parts.splice(edit.from, edit.to - edit.from + 1, { type: "input_text", text: edit.text });
    return { ...item, [field]: parts };
  });
  // Only plain placeholders need the note (a duplicate's content is still in view). It goes before the user message
  // that opens that turn, so it never splits a tool call from its output.
  if (firstPlain !== null) {
    let at = firstPlain;
    while (at > 0 && !(next[at].type === "message" && next[at].role === "user")) at--;
    next.splice(at, 0, { type: "message", role: "developer", content: [{ type: "input_text", text: WORDS[lang].note }] });
    report.noteAt = at;
  }
  return { items: next, report };
}
