// Purpose: P2 — replace the images the user unchecked with placeholder text in a Responses request's `input`.
// Nothing else changes: checked images, unknown images and all other items are forwarded as they are.
// v0.1 — placeholders say the image was seen when it appeared and is left out now by the user's choice, so the model
// keeps trusting what it said about it (user report 2026-09-25).
// v0.1-14 — in the user's language (Codex's interface language, language.ts): the Chinese wording is the one tested on
// 2026-09-25; the English one says the same and is checked by the same self-test (v01-placeholder-selftest.ts --lang en).
// v0.1-24 — how to ask for an image back is spelled out, for every GPT-6 model (self-tests with CAM_TEST_MODEL).
// v0.1-25 — once anything is left out, each image still sent carries its id, and the note says a checked image is back
// in its old place: GPT-6 Luna looked for it in the newest message and said it could not see it (user 2026-09-28).
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
  omitted: string; notRepeated: string; included: string; separator: string;
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
    included: "已提供",
    separator: "，",
    heading: (id, label, state, fields) => `[图片 ${id}${label ? `（${label}）` : ""} ${state}｜${fields.join("｜")}]`,
    plain: (id) => `原图被用户省略以节省上下文，情况见前面的“上下文管理说明”；需要重新看这张图时，在回复里写出“需要 ${id}”。`,
    duplicate: (id, where) => `这张图和 ${id}（${where}）内容完全相同，那一条在本次请求里照常提供，请直接参考那一条。`,
    note: [
      "上下文管理说明（来自用户安装的上下文素材管理工具）：为了节省上下文，用户取消勾选了这个任务里的部分图片。后面的对话里，这些图片原来的位置被换成了“[图片 IMG-xxx 已省略…]”这样的占位文字；仍在提供的图片前面标着“[图片 IMG-xxx 已提供…]”，紧接着就是原图。",
      "这些图片在它们出现的那一轮真实存在，你当时收到并看过；你之前对它们的描述，以及据此做出的判断，都是看着原图做出的，仍然有效。不要因为现在看不到，就认为之前的回答是猜测或错误，也不要收回或道歉。",
      "被问到现在能不能看到某张被省略的图片时，如实说明现在看不到（被用户省略了），并说明之前的描述仍然有效。现在看不到画面，就不要补充之前没说过的细节。需要重新看某张图时，在回复里原样写出“需要 IMG-xxx”（几张就写“需要 IMG-002、IMG-003”）：工具靠这几个字认出你要的图。用户重新勾选后，原图会回到它在对话里原来的位置：那里的占位文字换成“[图片 IMG-xxx 已提供…]”和原图；它不会出现在用户的新消息里，所以不要让用户重新上传或附上图片。不要自己用工具去读取这些图片。",
      "标着“[图片 IMG-xxx 已提供…]”的图片现在就在你面前，即使它之前被省略过、或者正是你要过的图：被问到它时，直接看图回答，不要说看不到。",
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
    included: "included",
    separator: ", ",
    heading: (id, label, state, fields) => `[Image ${id}${label ? ` (${label})` : ""} ${state} | ${fields.join(" | ")}]`,
    plain: (id) => `The user left out the original image to save context; see the "Context management note" above. If you need to see this image again, write "need ${id}" in your reply.`,
    duplicate: (id, where) => `This image is identical to ${id} (${where}), which is included in this request as usual; refer to that one.`,
    note: [
      "Context management note (from the context asset manager the user installed): to save context, the user unchecked some images in this task. Further on in the conversation, where those images were, there is now placeholder text such as \"[Image IMG-xxx omitted…]\"; each image still included is marked \"[Image IMG-xxx included…]\", with the original image right after it.",
      "These images really existed in the turn where they appeared, and you received and looked at them then; what you said about them before, and the judgments you based on it, were made looking at the original images and remain valid. Do not treat your earlier answers as guesses or mistakes because you cannot see the images now, and do not take them back or apologize.",
      "If asked whether you can see an omitted image now, say truthfully that you cannot see it now (the user left it out), and that your earlier descriptions remain valid. Since you cannot see it now, do not add details you did not mention before. If you need to look at an image again, write exactly \"need IMG-xxx\" in your reply (for several: \"need IMG-002, IMG-003\"): the tool finds the images you want by these words. Once the user checks an image again, its original is back in its old place in the conversation: the placeholder there becomes \"[Image IMG-xxx included…]\" followed by the original image. It does not come in the user's new message, so do not ask the user to upload or attach it again. Do not read these images yourself with tools.",
      "An image marked \"[Image IMG-xxx included…]\" is in front of you now, even if it was omitted before or is one you asked for: when asked about it, look at it and answer from it, and do not say you cannot see it.",
    ].join("\n"),
  },
};

// The Chinese note, tested on 2026-09-25; v0.1-24 (2026-09-28) spells out how to ask for an image back ("需要 IMG-xxx",
// several at once, no re-uploading), after GPT-6 Luna asked the user to "reattach" images instead; v0.1-25 says where a
// checked image comes back (its old place, marked "已提供"), after Luna looked for it in the newest message instead.
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

// Put right before an image that is still sent, so the model can tell which id it is: Codex's own labels ("[Image #2]")
// start again in every message.
export function includedLabel(image: Described, lang: Lang = "zh"): string {
  return heading(WORDS[lang], image, WORDS[lang].included);
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
  // Each edit puts one text part at `at`, in place of `remove` parts (none for a label).
  const edits = new Map<number, Array<{ at: number; remove: number; text: string }>>();
  const edit = (item: number, at: number, remove: number, text: string) => edits.set(item, [...(edits.get(item) ?? []), { at, remove, text }]);
  let firstPlain: number | null = null;
  for (const ref of drop) {
    const image = describe(ref)!;
    const copy = sent.find((other) => same(other, ref));
    const copyImage = copy ? describe(copy) ?? { id: WORDS[lang].newImage, name: copy.name, label: copy.label, kind: copy.kind, turn: null, width: copy.width, height: copy.height } : null;
    const text = copyImage ? duplicatePlaceholder(image, copyImage, lang) : plainPlaceholder(image, lang);
    if (!copyImage && firstPlain === null) firstPlain = ref.item;
    report.replaced.push({ id: image.id, key: ref.key, kind: ref.kind, mode: copyImage ? "duplicate" : "plain", sameAs: copyImage?.id ?? null, base64Chars: ref.base64Chars });
    const at = ref.openTag ?? ref.part!;
    edit(ref.item, at, (ref.closeTag ?? ref.part!) - at + 1, text);
  }
  // v0.1-25: a checked image sits in its old place among placeholders, so every image still sent is marked with its id.
  for (const ref of sent) {
    const image = ref.replaceable && ref.part !== null ? describe(ref) : undefined;
    if (image) edit(ref.item, ref.openTag ?? ref.part!, 0, includedLabel(image, lang));
  }
  const next = items.map((item, index) => {
    const list = edits.get(index);
    if (!list) return item;
    const field = item.type === "message" ? "content" : "output";
    const parts: Json[] = [...item[field]];
    for (const { at, remove, text } of list.sort((a, b) => b.at - a.at)) parts.splice(at, remove, { type: "input_text", text });
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
