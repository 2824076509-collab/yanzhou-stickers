import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { resolve, dirname, extname, sep } from "node:path";
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
const MCP_PATH = "/mcp";
const WIDGET_URI = "ui://widget/yanyan-sticker-v3.html";
const PORT = Number(process.env.PORT ?? 8787);

const MIME = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

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

function safeFilePath(relativePath) {
  const full = resolve(REPO_ROOT, relativePath);
  const rootPrefix = REPO_ROOT.endsWith(sep) ? REPO_ROOT : REPO_ROOT + sep;
  if (!(full === REPO_ROOT || full.startsWith(rootPrefix))) {
    throw new Error("Sticker path escapes repository root");
  }
  return full;
}

function scoreSticker(sticker, query) {
  const qRaw = String(query ?? "").trim();
  if (!qRaw) return 0;
  const q = normalize(qRaw);
  const tokens = qRaw.split(/[\s,，、/|]+/).map(normalize).filter(Boolean);
  const filename = normalize(sticker.filename);
  const meaning = normalize(sticker.meaning);
  const tags = Array.isArray(sticker.tags) ? sticker.tags.map(normalize) : [];

  let score = 0;
  if (filename.includes(q)) score += 12;
  if (meaning.includes(q)) score += 10;
  if (tags.some((tag) => tag === q)) score += 12;
  if (tags.some((tag) => tag.includes(q) || q.includes(tag))) score += 8;

  for (const token of tokens) {
    if (!token) continue;
    if (filename.includes(token)) score += 5;
    if (meaning.includes(token)) score += 4;
    for (const tag of tags) {
      if (tag === token) score += 6;
      else if (tag.includes(token) || token.includes(tag)) score += 3;
    }
  }
  return score;
}

function searchStickers(stickers, query, limit = 5) {
  return stickers
    .map((sticker, index) => ({ sticker, score: scoreSticker(sticker, query), index }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map(({ sticker, score }) => ({
      filename: sticker.filename,
      meaning: sticker.meaning ?? "",
      tags: Array.isArray(sticker.tags) ? sticker.tags : [],
      score,
    }));
}

function findSticker(stickers, filename) {
  return stickers.find((item) => item.filename === filename) ?? null;
}

const stickerSummarySchema = z.object({
  filename: z.string(),
  meaning: z.string(),
  tags: z.array(z.string()),
});

function createStickerServer() {
  const server = new McpServer({
    name: "yanyan-stickers",
    version: "0.2.0",
    instructions:
      "Yanyan's personal sticker library. In light casual conversation, search semantically first, choose one best sticker yourself, then show it. Do not ask the user to choose unless they explicitly want to browse. Prefer no more than one sticker per reply and skip spontaneous stickers in serious or high-stakes contexts.",
  });

  const widgetHtml = readFileSync(WIDGET_PATH, "utf8");
  registerAppResource(server, "yanyan-sticker-widget", WIDGET_URI, {}, async () => ({
    contents: [
      {
        uri: WIDGET_URI,
        mimeType: RESOURCE_MIME_TYPE,
        text: widgetHtml,
        _meta: {
          ui: { prefersBorder: false },
          "openai/widgetDescription": "Displays one selected sticker image inline.",
        },
      },
    ],
  }));

  registerAppTool(
    server,
    "search_stickers",
    {
      title: "Search Yanyan stickers",
      description:
        "Search Yanyan's personal sticker library by conversational meaning, emotion, relationship subtext, scene, or reaction. Use concise semantic keywords. Choose the single best result yourself; do not ask the user to pick unless they explicitly want to browse.",
      inputSchema: {
        query: z.string().min(1).describe("Concise semantic keywords, e.g. '摸头 被宠 开心'."),
        limit: z.number().int().min(1).max(8).optional().default(5),
      },
      outputSchema: {
        query: z.string(),
        stickers: z.array(stickerSummarySchema.extend({ score: z.number() })),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ query, limit }) => {
      const stickers = loadManifest();
      const matches = searchStickers(stickers, query, limit ?? 5);
      return {
        structuredContent: { query, stickers: matches },
        content: [
          {
            type: "text",
            text: matches.length
              ? `Found ${matches.length} matching stickers. Choose one exact filename and call show_sticker.`
              : "No matching stickers found.",
          },
        ],
      };
    }
  );

  registerAppTool(
    server,
    "list_stickers",
    {
      title: "List Yanyan stickers",
      description:
        "List the sticker catalog. Prefer search_stickers for normal conversation; use this when semantic search is insufficient or the user explicitly wants to browse.",
      inputSchema: {},
      outputSchema: { stickers: z.array(stickerSummarySchema) },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () => {
      const stickers = loadManifest().map((s) => ({
        filename: s.filename,
        meaning: s.meaning ?? "",
        tags: Array.isArray(s.tags) ? s.tags : [],
      }));
      return {
        structuredContent: { stickers },
        content: [{ type: "text", text: `There are ${stickers.length} stickers available.` }],
      };
    }
  );

  registerAppTool(
    server,
    "show_sticker",
    {
      title: "Show Yanyan sticker",
      description:
        "Display one exact sticker chosen from search_stickers or list_stickers. Use the exact filename returned by those tools. This renders the sticker directly in ChatGPT using MCP Apps UI.",
      inputSchema: {
        filename: z.string().min(1).describe("Exact filename returned by search_stickers or list_stickers."),
      },
      outputSchema: { sticker: stickerSummarySchema },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: {
        ui: { resourceUri: WIDGET_URI },
        "openai/outputTemplate": WIDGET_URI,
      },
    },
    async ({ filename }) => {
      const stickers = loadManifest();
      const sticker = findSticker(stickers, filename);
      if (!sticker) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Sticker not found: ${filename}. Call search_stickers and use an exact filename.`,
            },
          ],
        };
      }

      const imagePath = safeFilePath(String(sticker.path ?? ""));
      const ext = extname(imagePath).toLowerCase();
      const mimeType = MIME[ext];
      if (!mimeType) {
        return {
          isError: true,
          content: [{ type: "text", text: `Unsupported image type: ${ext}` }],
        };
      }

      const bytes = readFileSync(imagePath);
      const base64 = bytes.toString("base64");
      const summary = {
        filename: sticker.filename,
        meaning: sticker.meaning ?? "",
        tags: Array.isArray(sticker.tags) ? sticker.tags : [],
      };

      return {
        structuredContent: { sticker: summary },
        content: [],
        _meta: {
          sticker: {
            filename: sticker.filename,
            mimeType,
            base64,
            alt: sticker.meaning || sticker.filename,
          },
        },
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
    res.end("Yanyan Stickers MCP server v0.2.0");
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

  const MCP_METHODS = new Set(["POST", "GET", "DELETE"]);
  if (url.pathname === MCP_PATH && req.method && MCP_METHODS.has(req.method)) {
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
