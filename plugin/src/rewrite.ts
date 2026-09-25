// Purpose: P2 — replace the images the user unchecked with placeholder text in a Responses request's `input`.
// Nothing else changes: checked images, unknown images and all other items are forwarded as they are.
// v0.1 — placeholders say the image was seen when it appeared and is left out now by the user's choice, so the model
// keeps trusting what it said about it (user report 2026-09-25).
// Input: request items, a lookup into the thread index, the unchecked keys. Output: new items plus a metadata report.

import { findImages, type ImageKind, type ImageRef } from "./images.ts";

type Json = Record<string, any>;
export type Described = { id: string; name: string | null; label: string | null; kind: ImageKind; turn: number | null; width: number | null; height: number | null };
export type Replacement = { id: string; key: string; kind: ImageKind; mode: "plain" | "duplicate"; sameAs: string | null; base64Chars: number };
// noteAt: where the developer message explaining omitted images was inserted, if one was.
export type RewriteReport = { images: number; replaced: Replacement[]; locked: string[]; sentContentIds: string[]; noteAt?: number };

const KIND_TEXT: Record<ImageKind, string> = { upload: "用户上传", view: "工具查看的图片", generated: "生成的图片", tool: "工具结果里的图片" };

function heading(image: Described, state: string): string {
  const fields = [image.name ?? "未命名", KIND_TEXT[image.kind]];
  if (image.turn !== null) fields.push(`第 ${image.turn} 轮`);
  if (image.width && image.height) fields.push(`${image.width}×${image.height}`);
  return `[图片 ${image.id}${image.label ? `（${image.label}）` : ""} ${state}｜${fields.join("｜")}]`;
}

// The image sits in the history, so the model concludes it never saw it and takes back what it said about it (user
// report 2026-09-25). Saying otherwise inside the placeholder did not help: it is user content, which the model does
// not take as proof. So the explanation goes once into a developer message, before the turn where the first omitted
// image appeared, and each placeholder only points to it.
export const OMISSION_NOTE = [
  "上下文管理说明（来自用户安装的上下文素材管理工具）：为了节省上下文，用户取消勾选了这个任务里的部分图片。后面的对话里，这些图片原来的位置被换成了“[图片 IMG-xxx 已省略…]”这样的占位文字。",
  "这些图片在它们出现的那一轮真实存在，你当时收到并看过；你之前对它们的描述，以及据此做出的判断，都是看着原图做出的，仍然有效。不要因为现在看不到，就认为之前的回答是猜测或错误，也不要收回或道歉。",
  "被问到现在能不能看到时，如实说明现在看不到（被用户省略了），并说明之前的描述仍然有效。现在看不到画面，就不要补充之前没说过的细节；需要重新看某张图时，在回复里写出“需要 IMG-xxx”，用户可以重新勾选；不要自己用工具去读取这些图片。",
].join("\n");

export function plainPlaceholder(image: Described): string {
  return `${heading(image, "已省略")}\n原图被用户省略以节省上下文，情况见前面的“上下文管理说明”；需要重新看这张图时，在回复里写出“需要 ${image.id}”。`;
}

export function duplicatePlaceholder(image: Described, same: Described): string {
  const where = [same.name, same.turn !== null ? `第 ${same.turn} 轮` : "本轮"].filter(Boolean).join("，");
  return `${heading(image, "未重复提供")}\n这张图和 ${same.id}（${where}）内容完全相同，那一条在本次请求里照常提供，请直接参考那一条。`;
}

export function rewriteItems(
  items: Json[],
  describe: (ref: ImageRef) => Described | undefined,
  unchecked: Set<string>,
  pixelHash: (ref: ImageRef) => string | null,
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
    const copyImage = copy ? describe(copy) ?? { id: "（新图片）", name: copy.name, label: copy.label, kind: copy.kind, turn: null, width: copy.width, height: copy.height } : null;
    const text = copyImage ? duplicatePlaceholder(image, copyImage) : plainPlaceholder(image);
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
    next.splice(at, 0, { type: "message", role: "developer", content: [{ type: "input_text", text: OMISSION_NOTE }] });
    report.noteAt = at;
  }
  return { items: next, report };
}
