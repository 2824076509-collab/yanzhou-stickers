import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const MANIFEST_PATH = process.env.STICKER_MANIFEST_PATH || resolve(REPO_ROOT, "stickers.json");
const WIDGET_PATH = resolve(__dirname, "public", "sticker-widget.html");
const WIDGET_URI = "ui://widget/yanyan-sticker-v4.html";
const MCP_PATH = "/mcp";
const PORT = Number(process.env.PORT ?? 8787);
const CDN_ORIGIN = "https://cdn.jsdelivr.net";

function normalize(value = "") {
  return String(value)
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

function loadManifest() {
  const raw = readFileSync(MANIFEST_PATH, "utf8");
  const data = JSON.parse(raw);
  if (!data || !Array.isArray(data.stickers)) {
    throw new Error("stickers.json must contain a stickers array");
  }
  return data.stickers;
}

function scoreSticker(sticker, query) {
  const qRaw = String(query ?? "").trim();
  if (!qRaw) return 0;
  const q = normalize(qRaw);
  const tokens = qRaw.split(/[\s,，、/|]+/).map(normalize).filter(Boolean);
  const name = normalize(sticker.name);
  const meaning = normalize(sticker.meaning);
  const labels = Array.isArray(sticker.labels) ? sticker.labels.map(normalize) : [];

  let score = 0;
  if (name.includes(q)) score += 12;
  if (meaning.includes(q)) score += 10;
  if (labels.some((label) => label === q)) score += 12;
  if (labels.some((label) => label.includes(q) || q.includes(label))) score += 8;

  for (const token of tokens) {
    if (name.includes(token)) score += 5;
    if (meaning.includes(token)) score += 4;
    for (const label of labels) {
      if (label === token) score += 6;
      else if (label.includes(token) || token.includes(label)) score += 3;
    }
  }
  return score;
}

function toPublicSticker(sticker) {
  return {
    id: sticker.id,
    name: sticker.name,
    labels: Array.isArray(sticker.labels) ? sticker.labels : [],
    meaning: sticker.meaning ?? "",
    imageUrl: sticker.imageUrl,
  };
}

function searchStickers(stickers, query, limit = 5) {
  return stickers
    .map((sticker, index) => ({ sticker, score: scoreSticker(sticker, query), index }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map(({ sticker, score }) => ({ ...toPublicSticker(sticker), score }));
}

const stickerSchema = z.object({
  id: z.string(),
  name: z.string(),
  labels: z.array(z.string()),
  meaning: z.string(),
  imageUrl: z.string().url(),
});

function createStickerServer() {
  const server = new McpServer({
    name: "yanyan-stickers",
    version: "0.4.0",
    instructions:
      "Yanyan's personal sticker library. In light casual conversation, call sticker_search with semantic keywords, choose the best match yourself, then call sticker_pick with its exact id. Do not ask the user to choose unless they explicitly want to browse. Prefer one sticker per eligible reply and skip spontaneous stickers in serious or high-stakes contexts.",
  });

  registerAppResource(
    server,
    "yanyan-sticker-card-v4",
    WIDGET_URI,
    {
      title: "言言的表情包",
      description: "在 ChatGPT 中直接显示一张表情包图片。",
      mimeType: RESOURCE_MIME_TYPE,
    },
    async () => ({
      contents: [
        {
          uri: WIDGET_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: readFileSync(WIDGET_PATH, "utf8"),
          _meta: {
            ui: {
              prefersBorder: false,
              csp: {
                connectDomains: [],
                resourceDomains: [CDN_ORIGIN],
              },
            },
            "openai/widgetDescription": "显示从言言的表情包库中挑选出的图片。",
            "openai/widgetPrefersBorder": false,
            "openai/widgetCSP": {
              connect_domains: [],
              resource_domains: [CDN_ORIGIN],
            },
          },
        },
      ],
    })
  );

  registerAppTool(
    server,
    "sticker_search",
    {
      title: "搜索言言的表情包",
      description:
        "按当前聊天的语境、情绪、动作或关系潜台词搜索表情包。先搜索，再自行挑选一个最合适的结果调用 sticker_pick。",
      inputSchema: {
        query: z.string().min(1).describe("2 到 5 个简短语义词，例如：贴贴 撒娇 亲密。"),
        limit: z.number().int().min(1).max(8).optional().default(5),
      },
      outputSchema: {
        query: z.string(),
        matches: z.array(stickerSchema.extend({ score: z.number() })),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ query, limit }) => {
      const matches = searchStickers(loadManifest(), query, limit ?? 5);
      return {
        structuredContent: { query, matches },
        content: [
          {
            type: "text",
            text: matches.length
              ? `找到 ${matches.length} 张候选表情包。请自行选择最合适的一张，并用它的 id 调用 sticker_pick。`
              : "没有找到合适的表情包。",
          },
        ],
      };
    }
  );

  registerAppTool(
    server,
    "sticker_pick",
    {
      title: "发送言言的表情包",
      description:
        "用 sticker_search 返回的准确 id 选择并显示一张表情包。图片 URL 会随 structuredContent 一次返回，UI 不会再次调用工具。",
      inputSchema: {
        id: z.string().min(1).describe("sticker_search 返回的准确表情包 id。"),
      },
      outputSchema: stickerSchema,
      _meta: {
        ui: { resourceUri: WIDGET_URI },
        "openai/outputTemplate": WIDGET_URI,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ id }) => {
      const sticker = loadManifest().find((item) => item.id === id);
      if (!sticker) {
        return {
          isError: true,
          content: [{ type: "text", text: `没有找到表情包：${id}。请重新调用 sticker_search。` }],
        };
      }

      const picked = toPublicSticker(sticker);
      return {
        structuredContent: picked,
        content: [{ type: "text", text: `已选择表情包：${picked.name}` }],
      };
    }
  );

  return server;
}

const httpServer = createServer(async (req, res) => {
  if (!req.url) {
    res.writeHead(400).end("Missing URL");
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);

  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end("Yanyan Stickers MCP server v0.4.0");
    return;
  }

  if (req.method === "OPTIONS" && url.pathname === MCP_PATH) {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "content-type, mcp-session-id",
      "Access-Control-Expose-Headers": "Mcp-Session-Id",
    });
    res.end();
    return;
  }

  const mcpMethods = new Set(["POST", "GET", "DELETE"]);
  if (url.pathname === MCP_PATH && req.method && mcpMethods.has(req.method)) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");

    const server = createStickerServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    res.on("close", () => {
      transport.close();
      server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      console.error("MCP request failed", error);
      if (!res.headersSent) res.writeHead(500).end("Internal server error");
    }
    return;
  }

  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("Not Found");
});

httpServer.listen(PORT, () => {
  console.log(`Yanyan Stickers MCP listening on http://0.0.0.0:${PORT}${MCP_PATH}`);
});
