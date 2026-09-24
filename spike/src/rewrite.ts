// Purpose: P2 — replace the images the user unchecked with placeholder text in a Responses request's `input`.
// Nothing else changes: checked images, unknown images and all other items are forwarded as they are.
// Input: request items, a lookup into the thread index, the unchecked keys. Output: new items plus a metadata report.

import { findImages, type ImageKind, type ImageRef } from "./images.ts";

type Json = Record<string, any>;
export type Described = { id: string; name: string | null; label: string | null; kind: ImageKind; turn: number | null; width: number | null; height: number | null };
export type Replacement = { id: string; key: string; kind: ImageKind; mode: "plain" | "duplicate"; sameAs: string | null; base64Chars: number };
export type RewriteReport = { images: number; replaced: Replacement[]; locked: string[]; sentContentIds: string[] };

const KIND_TEXT: Record<ImageKind, string> = { upload: "用户上传", view: "工具查看的图片", generated: "生成的图片", tool: "工具结果里的图片" };

function heading(image: Described, state: string): string {
  const fields = [image.name ?? "未命名", KIND_TEXT[image.kind]];
  if (image.turn !== null) fields.push(`第 ${image.turn} 轮`);
  if (image.width && image.height) fields.push(`${image.width}×${image.height}`);
  return `[图片 ${image.id}${image.label ? `（${image.label}）` : ""} ${state}｜${fields.join("｜")}]`;
}

export function plainPlaceholder(image: Described): string {
  return `${heading(image, "未提供")}\n用户为了控制上下文，这次没有提供这张图，你看不到它的内容，不要猜测或描述画面细节。如果回答需要看这张图，请在回复里写出“需要 ${image.id}”，用户可以在下一轮重新勾选提供；不要自己用工具去读取它。`;
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
  for (const ref of drop) {
    const image = describe(ref)!;
    const copy = sent.find((other) => same(other, ref));
    const copyImage = copy ? describe(copy) ?? { id: "（新图片）", name: copy.name, label: copy.label, kind: copy.kind, turn: null, width: copy.width, height: copy.height } : null;
    const text = copyImage ? duplicatePlaceholder(image, copyImage) : plainPlaceholder(image);
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
  return { items: next, report };
}
