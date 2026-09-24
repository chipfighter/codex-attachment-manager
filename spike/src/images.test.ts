// Purpose: P2 — image discovery in Responses items: keys, kinds, names, Codex's upload tags and header sizes.
// Input: synthetic items shaped like the P2-1 request dumps; output: Node test assertions only.

import assert from "node:assert/strict";
import test from "node:test";
import { findImages, imageSize } from "./images.ts";
import { png } from "./testkit.ts";

const url = (bytes: Buffer) => `data:image/png;base64,${bytes.toString("base64")}`;
const red = png(4, 3, () => [255, 0, 0]);
const blue = png(5, 5, () => [0, 0, 255]);

const upload = (id: string, turn: string, names: string[], images: Buffer[]) => ({
  type: "message",
  id,
  role: "user",
  content: [
    { type: "input_text", text: "看看这些图" },
    ...names.flatMap((name, i) => [
      { type: "input_text", text: `<image name=[Image #${i + 1}] path="C:\\work\\shots\\${name}">` },
      { type: "input_image", image_url: url(images[i]), detail: "high" },
      { type: "input_text", text: "</image>" },
    ]),
  ],
  internal_chat_message_metadata_passthrough: { turn_id: turn },
});

test("uploads: key from the item id, name and label from Codex's tag, tags recorded for replacement", () => {
  const refs = findImages([upload("msg_1", "turn-1", ["a.png", "a copy.png"], [red, red])]);
  assert.equal(refs.length, 2);
  assert.deepEqual(refs.map((r) => [r.key, r.kind, r.name, r.label, r.openTag, r.part, r.closeTag, r.turnId]), [
    ["msg_1#0", "upload", "a.png", "[Image #1]", 1, 2, 3, "turn-1"],
    ["msg_1#1", "upload", "a copy.png", "[Image #2]", 4, 5, 6, "turn-1"],
  ]);
  assert.equal(refs[0].contentId, refs[1].contentId, "same bytes, same content id, whatever the name");
  assert.deepEqual([refs[0].width, refs[0].height, refs[0].mime], [4, 3, "image/png"]);
});

test("code-mode tool outputs: view_image paths and generated-image hints name the images", () => {
  const items = [
    { type: "custom_tool_call", call_id: "c1", name: "exec", input: 'const r = await tools.view_image({path:"D:\\\\shots\\\\c.png"}); image(r.image_url);' },
    { type: "custom_tool_call_output", id: "ctco_1", call_id: "c1", output: [{ type: "input_text", text: "Script completed" }, { type: "input_image", image_url: url(blue) }] },
    { type: "custom_tool_call", call_id: "c2", name: "exec", input: 'const r = await tools.image_gen__imagegen({prompt:"x"}); generatedImage(r);' },
    { type: "custom_tool_call_output", id: "ctco_2", call_id: "c2", output: [{ type: "input_image", image_url: url(red) }, { type: "input_text", text: "Generated images are saved to C:\\g\\t as C:\\g\\t\\exec-1.png by default.\nIf you need…" }] },
    { type: "function_call", call_id: "c3", name: "view_image", arguments: JSON.stringify({ path: "/tmp/d.png" }) },
    { type: "function_call_output", call_id: "c3", output: [{ type: "input_image", image_url: url(blue) }] },
  ];
  assert.deepEqual(findImages(items).map((r) => [r.key, r.kind, r.name, r.openTag]), [
    ["ctco_1#0", "view", "c.png", null],
    ["ctco_2#0", "generated", "exec-1.png", null],
    ["function_call_output:c3#0", "view", "d.png", null],
  ]);
});

test("hosted image generation results are found but cannot be replaced", () => {
  const [ref] = findImages([{ type: "image_generation_call", id: "ig_1", status: "completed", result: red.toString("base64") }]);
  assert.deepEqual([ref.key, ref.kind, ref.replaceable, ref.part], ["ig_1#0", "generated", false, null]);
});

test("items without ids fall back to type, turn and content, numbered in order", () => {
  const plain = (text: string) => ({ type: "message", role: "user", content: [{ type: "input_text", text }, { type: "input_image", image_url: url(red) }] });
  const refs = findImages([plain("one"), plain("two")]);
  assert.equal(refs.length, 2);
  assert.notEqual(refs[0].key, refs[1].key);
  assert.match(refs[0].key, new RegExp(`^message:user::${refs[0].contentId}#0$`));
});

test("image sizes come from PNG, GIF and JPEG headers", () => {
  assert.deepEqual(imageSize(blue), { width: 5, height: 5 });
  const gif = Buffer.from("474946383961" + "0a00" + "0700", "hex");
  assert.deepEqual(imageSize(gif), { width: 10, height: 7 });
  // SOI, an APP0 segment, then SOF0 with height 300 and width 400.
  const jpeg = Buffer.from("ffd8" + "ffe00004" + "0000" + "ffc0000b08012c0190030100", "hex");
  assert.deepEqual(imageSize(jpeg), { width: 400, height: 300 });
});

test("view_image through a variable path is still a viewed image; single-quoted inline paths are read", () => {
  const items = [
    { type: "custom_tool_call", call_id: "c1", name: "exec", input: "const paths = ['C:\\\\a.png'];\nconst calls = paths.map(path => tools.view_image({path, detail: 'original'}));" },
    { type: "custom_tool_call_output", id: "ctco_1", call_id: "c1", output: [{ type: "input_image", image_url: url(red) }] },
    { type: "custom_tool_call", call_id: "c2", name: "exec", input: "await tools.view_image({ path: 'D:\\\\x\\\\e.png' })" },
    { type: "custom_tool_call_output", id: "ctco_2", call_id: "c2", output: [{ type: "input_image", image_url: url(blue) }] },
  ];
  assert.deepEqual(findImages(items).map((r) => [r.kind, r.name]), [["view", null], ["view", "e.png"]]);
});
