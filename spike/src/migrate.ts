// Purpose: turn a source thread's UI-level turns (app-server thread/turns/list) into the raw Responses items
// injected into a rebuilt thread: text is kept, images become placeholders, tool calls become one-line records.
// Input: turns, an image resolver, and the selection. Output: items plus bookkeeping (pure, no I/O).

type Json = Record<string, any>;
export type AssetInfo = { assetId: string; name: string; width: number | null; height: number | null; bytes: number };
export type ResolveImage = (pathOrUrl: string) => AssetInfo | null;
export type MigrationOptions = {
  sourceName: string;
  // Asset id -> attachment number in the first new turn; assets not listed are omitted.
  attachments: Map<string, number>;
};
export type FirstSeen = { asset: AssetInfo; turn: number; source: string };
export type Migration = { items: Json[]; firstSeen: FirstSeen[]; imageOccurrences: number; unresolvedImages: number };

const message = (role: "user" | "assistant" | "developer", text: string): Json => ({
  type: "message",
  role,
  content: [{ type: role === "assistant" ? "output_text" : "input_text", text }],
});

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);
const megabytes = (bytes: number) => (bytes / 1_048_576).toFixed(1);
const dimensions = (asset: AssetInfo) => (asset.width && asset.height ? `${asset.width}×${asset.height}` : "尺寸未知");

export const baseName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

// Tool records keep file names but never absolute paths, so the model is not pointed at omitted files.
// Quoted paths may contain spaces and are replaced whole; unquoted paths end at whitespace.
export function redactPaths(text: string): string {
  return text
    .replace(/(['"])([A-Za-z]:\\[^'"]*|\/[^'"]*\/[^'"]*)\1/g, (_match, quote: string, path: string) => `${quote}${baseName(path)}${quote}`)
    .replace(/[A-Za-z]:\\[^\s'"]+/g, (path) => baseName(path))
    .replace(/(?<![\w.])\/(?:[^/\s'"]+\/)+[^/\s'"]+/g, (path) => baseName(path));
}

function placeholder(asset: AssetInfo, turn: number, source: string, note: string, attachment: number | undefined): string {
  const header = `[素材 ${asset.assetId}｜图片｜${asset.name}｜${dimensions(asset)}｜${megabytes(asset.bytes)} MB｜原任务第 ${turn} 轮${source}]`;
  const status = attachment !== undefined
    ? `状态：已在新任务中作为附件 ${attachment} 提供。`
    : `状态：本轮未提供图像内容（为控制上下文而省略），不能据此判断画面细节。如需查看，请回复“需要 ${asset.assetId}”，用户勾选后会在下一轮作为附件提供。`;
  return `${header}\n来源说明：${note}\n${status}`;
}

function toolRecord(item: Json, imageText: (path: string) => string): string | null {
  switch (item.type) {
    case "reasoning": return null;
    case "commandExecution": return `执行命令（退出码 ${item.exitCode ?? "未知"}）：${clip(redactPaths(String(item.command ?? "")), 80)}`;
    case "webSearch": return `网页搜索：${clip(String(item.query ?? ""), 60)}`;
    case "fileChange": return `修改文件：${(item.changes ?? []).map((change: Json) => baseName(String(change.path ?? ""))).join("、")}`;
    case "mcpToolCall": return `调用工具 ${item.server}.${item.tool}`;
    case "imageView": return `用看图工具查看了图片 ${imageText(item.path)}`;
    default: return `${item.type}`;
  }
}

export function buildMigration(turns: Json[], resolve: ResolveImage, options: MigrationOptions): Migration {
  const history: Json[] = [];
  const firstSeen: FirstSeen[] = [];
  const seen = new Set<string>();
  let imageOccurrences = 0;
  let unresolvedImages = 0;

  const imageText = (pathOrUrl: string, turn: number, source: string, note: string): string => {
    imageOccurrences++;
    const asset = resolve(pathOrUrl);
    if (!asset) {
      unresolvedImages++;
      return `[记录 #${imageOccurrences}：一张未能识别的图片（${source}），本轮未提供图像内容，不能据此判断画面细节]`;
    }
    if (seen.has(asset.assetId)) return `[记录 #${imageOccurrences}：与 ${asset.assetId} 为同一素材，此处不重复提供]`;
    seen.add(asset.assetId);
    firstSeen.push({ asset, turn, source });
    return placeholder(asset, turn, source, note, options.attachments.get(asset.assetId));
  };

  for (const [index, turn] of turns.entries()) {
    const number = index + 1;
    let records: string[] = [];
    const flush = () => {
      if (records.length) history.push(message("assistant", `[工具记录] ${records.join("；")}`));
      records = [];
    };
    for (const item of turn.items ?? []) {
      if (item.type === "userMessage") {
        flush();
        const text = (item.content ?? []).filter((part: Json) => part.type === "text").map((part: Json) => part.text).join("\n");
        const parts = [`【原任务第 ${number} 轮】`];
        for (const part of item.content ?? []) {
          if (part.type === "text") parts.push(part.text);
          else if (part.type === "localImage" || part.type === "image") {
            parts.push(imageText(part.path ?? part.url, number, "用户上传", `用户随附的话：“${clip(text.replace(/\s+/g, " ").trim(), 60)}”`));
          } else parts.push(`[${part.type}]`);
        }
        history.push(message("user", parts.join("\n")));
      } else if (item.type === "agentMessage") {
        flush();
        history.push(message("assistant", item.text ?? ""));
      } else {
        const record = toolRecord(item, (path) => imageText(path, number, "看图工具查看", "模型用看图工具查看"));
        if (record) records.push(record);
      }
    }
    flush();
    if (turn.status && turn.status !== "completed") {
      const label = turn.status === "failed" ? "失败" : turn.status === "interrupted" ? "被中断" : turn.status;
      history.push(message("assistant", `[此轮未完成：${label}]`));
    }
  }

  const table = firstSeen.map(({ asset, turn, source }) => {
    const attachment = options.attachments.get(asset.assetId);
    const status = attachment !== undefined ? `新任务第 1 轮附件 ${attachment}` : "未提供";
    return `- ${asset.assetId}｜${asset.name}｜${dimensions(asset)}｜${megabytes(asset.bytes)} MB｜首次出现：原任务第 ${turn} 轮（${source}）｜${status}`;
  });
  const index = message("developer", [
    "[Codex 附件管理器 · 重建说明]",
    `这个任务由 Codex 附件管理器从原任务「${options.sourceName}」重建。原任务的历史图片以内联数据随每次请求重复发送，请求过大后无法继续。`,
    "下面是原任务的对话文字；图片不直接附带，用素材编号和占位符表示；工具调用只保留一行记录。",
    "规则：",
    "1. 标为“未提供”的素材，你没有看到它的画面，不能据此描述或判断任何画面细节。",
    "2. 需要查看某个素材时，请直接回复“需要 IMG-xxx”，由用户勾选后在下一轮作为附件提供。不要用工具自行读取这些图片文件。",
    "3. 用户附带素材时会注明“附件 k = IMG-xxx”，此后你就能看到该素材。",
    "素材表：",
    ...table,
  ].join("\n"));

  return { items: [index, ...history], firstSeen, imageOccurrences, unresolvedImages };
}
