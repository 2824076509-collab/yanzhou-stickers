import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const OWNER = "2824076509-collab";
const REPO = "yanzhou-stickers";
const BRANCH = "main";
const MANIFEST_URL = `https://raw.githubusercontent.com/${OWNER}/${REPO}/${BRANCH}/stickers.json`;
const RAW_BASE = `https://raw.githubusercontent.com/${OWNER}/${REPO}/${BRANCH}/`;
const CDN_BASE = `https://cdn.jsdelivr.net/gh/${OWNER}/${REPO}@${BRANCH}/`;
const STICKER_WIDGET_URI = "ui://widget/yanzhou-sticker-v2.html";

async function loadManifest() {
  const response = await fetch(MANIFEST_URL, {
    headers: { "user-agent": "yanzhou-stickers-mcp/0.3" },
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Could not load sticker manifest: HTTP ${response.status}`);
  const data = await response.json();
  if (!data || !Array.isArray(data.stickers)) throw new Error("Sticker manifest is invalid.");
  return data.stickers;
}

function normalize(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\.(jpe?g|png|webp|gif)$/i, "")
    .replace(/[，。！？、；：,.!?;:()（）\[\]{}"'“”‘’]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function queryTerms(value) {
  const normalized = normalize(value);
  if (!normalized) return [];
  const terms = normalized.split(" ").filter(Boolean);
  return [...new Set(terms)];
}

function findSticker(stickers, query) {
  const q = normalize(query);
  return stickers.find((item) => {
    const filename = normalize(item.filename);
    const pathName = normalize(item.path?.split("/").pop());
    return filename === q || pathName === q;
  });
}

function scoreSticker(sticker, query) {
  const normalizedQuery = normalize(query);
  const terms = queryTerms(query);
  const filename = normalize(sticker.filename);
  const meaning = normalize(sticker.meaning);
  const tags = Array.isArray(sticker.tags) ? sticker.tags.map(normalize) : [];
  const tagText = tags.join(" ");
  const allText = [filename, meaning, tagText].join(" ");

  let score = 0;

  if (normalizedQuery && allText.includes(normalizedQuery)) score += 12;
  if (normalizedQuery && meaning.includes(normalizedQuery)) score += 6;

  for (const term of terms) {
    if (!term) continue;
    if (tags.some((tag) => tag === term)) score += 8;
    else if (tags.some((tag) => tag.includes(term) || term.includes(tag))) score += 5;

    if (meaning.includes(term)) score += 4;
    if (filename.includes(term)) score += 2;
  }

  return score;
}

function searchStickers(stickers, query, limit) {
  return stickers
    .map((sticker, index) => ({
      sticker,
      index,
      score: scoreSticker(sticker, query),
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, Math.max(1, Math.min(limit, 12)))
    .map(({ sticker, score }) => ({
      filename: sticker.filename,
      meaning: sticker.meaning ?? "",
      tags: Array.isArray(sticker.tags) ? sticker.tags : [],
      score,
    }));
}

function encodePath(path) {
  return String(path).split("/").map(encodeURIComponent).join("/");
}

function createStickerServer() {
  const server = new McpServer(
    { name: "yanzhou-stickers", version: "0.3.0" },
    {
      instructions:
        "This is Yanzhou's personal sticker expression library. In affectionate, playful, teasing, pouting, comforting, celebratory, or emotionally expressive casual chat, autonomously decide whether a sticker would feel natural. Do not ask the user to choose. Use search_stickers with concise semantic keywords derived from the current conversational subtext, inspect the candidates, personally choose the best one, then call show_sticker. Prefer one fitting sticker, avoid repetitive use, and skip spontaneous stickers in serious or high-stakes contexts.",
    },
  );

  const stickerWidgetHtml = `
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
  <style>
    *{box-sizing:border-box}
    html,body{margin:0;padding:0;background:transparent}
    body{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    .wrap{display:flex;justify-content:flex-start;padding:4px 0}
    .card{display:inline-block;max-width:min(340px,88vw);overflow:hidden;border-radius:16px;background:transparent}
    img{display:block;max-width:100%;width:auto;height:auto;max-height:420px;object-fit:contain;border-radius:16px}
    .caption{display:none}
  </style>
</head>
<body>
  <div class="wrap"><div class="card"><img id="sticker" alt="表情包" /><div id="caption" class="caption"></div></div></div>
  <script>
    const image = document.getElementById("sticker");
    const caption = document.getElementById("caption");
    function render(value) {
      const data = value && value.structuredContent ? value.structuredContent : value;
      if (!data || !data.url) return;
      image.src = data.url;
      image.alt = data.alt || "表情包";
      caption.textContent = data.caption || data.alt || "";
    }
    if (window.openai && window.openai.toolOutput) render(window.openai.toolOutput);
    window.addEventListener("message", (event) => {
      if (event.source !== window.parent) return;
      const message = event.data;
      if (!message || message.jsonrpc !== "2.0") return;
      if (message.method === "ui/notifications/tool-result") render(message.params);
      if (message.method === "openai:set_globals") {
        render(message.params && message.params.globals && message.params.globals.toolOutput);
      }
    }, { passive: true });
  </script>
</body>
</html>
  `.trim();

  server.registerResource(
    "yanzhou-sticker-widget",
    STICKER_WIDGET_URI,
    {},
    async () => ({
      contents: [
        {
          uri: STICKER_WIDGET_URI,
          mimeType: "text/html;profile=mcp-app",
          text: stickerWidgetHtml,
          _meta: {
            ui: {
              prefersBorder: false,
              csp: {
                connectDomains: ["https://cdn.jsdelivr.net"],
                resourceDomains: ["https://cdn.jsdelivr.net"],
              },
            },
          },
          "openai/widgetDescription": "在聊天中直接显示砚舟自己选中的表情包",
        },
      ],
    }),
  );

  server.registerTool(
    "search_stickers",
    {
      title: "Search Yanzhou stickers",
      description:
        "Search Yanzhou's sticker library by conversational meaning, emotion, relationship subtext, scene, or reaction. Use concise semantic keywords such as '委屈 撒娇 被欺负 猫猫'. This is the preferred first step before show_sticker; do not ask the user to choose among results.",
      inputSchema: {
        query: z.string().min(1).describe("Short semantic search derived from the current conversation."),
        limit: z.number().int().min(1).max(12).optional().default(6),
      },
      outputSchema: {
        query: z.string(),
        stickers: z.array(z.object({
          filename: z.string(),
          meaning: z.string(),
          tags: z.array(z.string()),
          score: z.number(),
        })),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
        destructiveHint: false,
      },
    },
    async ({ query, limit = 6 }) => {
      const stickers = await loadManifest();
      const matches = searchStickers(stickers, query, limit);
      return {
        structuredContent: { query, stickers: matches },
        content: [{
          type: "text",
          text:
            matches.length > 0
              ? `Found ${matches.length} sticker candidates. Choose the single best match yourself, then call show_sticker with its exact filename. Do not ask the user to pick.`
              : "No sticker candidates found.",
        }],
      };
    },
  );

  server.registerTool(
    "list_stickers",
    {
      title: "List Yanzhou stickers",
      description:
        "Fallback catalog listing. Prefer search_stickers for normal conversation. Use this only when semantic search is insufficient or the user explicitly asks to browse the library.",
      inputSchema: {},
      outputSchema: {
        stickers: z.array(z.object({
          filename: z.string(),
          meaning: z.string(),
          tags: z.array(z.string()),
        })),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
        destructiveHint: false,
      },
    },
    async () => {
      const stickers = await loadManifest();
      const compact = stickers.map(({ filename, meaning, tags }) => ({
        filename,
        meaning: meaning ?? "",
        tags: Array.isArray(tags) ? tags : [],
      }));
      return {
        structuredContent: { stickers: compact },
        content: [{
          type: "text",
          text: `There are ${compact.length} stickers available. Prefer search_stickers for contextual selection.`,
        }],
      };
    },
  );

  server.registerTool(
    "show_sticker",
    {
      title: "Send a Yanzhou sticker",
      description:
        "Send one exact sticker selected by the assistant. Use an exact filename returned by search_stickers or list_stickers. The assistant should choose autonomously from context and should not ask the user to select.",
      inputSchema: {
        filename: z.string().min(1).describe("Exact sticker filename returned by search_stickers."),
      },
      outputSchema: {
        url: z.string(),
        alt: z.string(),
        caption: z.string(),
      },
      _meta: {
        ui: { resourceUri: STICKER_WIDGET_URI },
        "openai/outputTemplate": STICKER_WIDGET_URI,
        "openai/toolInvocation/invoking": "正在挑一张合适的表情包…",
        "openai/toolInvocation/invoked": " ",
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
        destructiveHint: false,
      },
    },
    async ({ filename }) => {
      const stickers = await loadManifest();
      const sticker = findSticker(stickers, filename);
      if (!sticker) {
        return {
          isError: true,
          content: [{
            type: "text",
            text: `Sticker not found: ${filename}. Call search_stickers and use an existing exact filename.`,
          }],
        };
      }

      const path = String(sticker.path ?? "");
      const extMatch = path.toLowerCase().match(/\.(jpg|jpeg|png|webp|gif)$/);
      if (!extMatch) {
        return {
          isError: true,
          content: [{ type: "text", text: `Unsupported sticker image type: ${sticker.filename}` }],
        };
      }

      const mimeByExt = {
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        png: "image/png",
        webp: "image/webp",
        gif: "image/gif",
      };
      const mimeType = mimeByExt[extMatch[1]];

      const encodedPath = encodePath(path);
      const imageUrl = CDN_BASE + encodedPath;
      const rawImageUrl = RAW_BASE + encodedPath;
      const imageResponse = await fetch(rawImageUrl, {
        headers: { "user-agent": "yanzhou-stickers-mcp/0.3" },
        cache: "no-store",
      });
      if (!imageResponse.ok) throw new Error(`Could not load sticker image: HTTP ${imageResponse.status}`);

      const bytes = Buffer.from(await imageResponse.arrayBuffer());
      const base64 = bytes.toString("base64");
      const meaning = sticker.meaning ?? "";

      return {
        structuredContent: {
          url: imageUrl,
          alt: sticker.filename,
          caption: meaning || sticker.filename,
        },
        content: [
          {
            type: "image",
            data: base64,
            mimeType,
          },
        ],
      };
    },
  );

  return server;
}

const port = Number(process.env.PORT ?? 8787);
const MCP_PATH = "/mcp";

const httpServer = createServer(async (req, res) => {
  if (!req.url) {
    res.writeHead(400).end("Missing URL");
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);

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

  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end("Yanzhou Stickers MCP server");
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
      console.error("Error handling MCP request:", error);
      if (!res.headersSent) res.writeHead(500).end("Internal server error");
    }
    return;
  }

  res.writeHead(404).end("Not Found");
});

httpServer.listen(port, "0.0.0.0", () => {
  console.log(`Yanzhou Stickers MCP listening on http://0.0.0.0:${port}${MCP_PATH}`);
});
