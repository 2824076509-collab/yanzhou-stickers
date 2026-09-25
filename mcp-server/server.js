import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const OWNER = "2824076509-collab";
const REPO = "yanzhou-stickers";
const BRANCH = "main";
const MANIFEST_URL = `https://raw.githubusercontent.com/${OWNER}/${REPO}/${BRANCH}/stickers.json`;
const RAW_BASE = `https://raw.githubusercontent.com/${OWNER}/${REPO}/${BRANCH}/`;

async function loadManifest() {
  const response = await fetch(MANIFEST_URL, {
    headers: { "user-agent": "yanzhou-stickers-mcp/0.1" },
  });
  if (!response.ok) throw new Error(`Could not load sticker manifest: HTTP ${response.status}`);
  const data = await response.json();
  if (!data || !Array.isArray(data.stickers)) throw new Error("Sticker manifest is invalid.");
  return data.stickers;
}

function normalize(value) {
  return String(value ?? "").trim().toLowerCase().replace(/\.(jpe?g|png|webp|gif)$/i, "");
}

function findSticker(stickers, query) {
  const q = normalize(query);
  return stickers.find((item) => {
    const filename = normalize(item.filename);
    const pathName = normalize(item.path?.split("/").pop());
    return filename === q || pathName === q;
  });
}

function createStickerServer() {
  const server = new McpServer(
    { name: "yanzhou-stickers", version: "0.1.0" },
    {
      instructions:
        "This server exposes Yanzhou's personal sticker library. Use list_stickers to inspect available stickers and show_sticker to return the selected JPG image itself. Choose by conversational meaning and tags; do not invent filenames.",
    },
  );

  server.registerTool(
    "list_stickers",
    {
      title: "List Yanzhou stickers",
      description:
        "List the available stickers with filenames, meanings, and semantic tags. Use this before choosing a sticker when you need to inspect the library.",
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
          text: `There are ${compact.length} stickers available. Choose one by filename, meaning, and tags, then call show_sticker.`,
        }],
      };
    },
  );

  server.registerTool(
    "show_sticker",
    {
      title: "Show a Yanzhou sticker",
      description:
        "Return one sticker as an actual JPEG image in the tool result. Pass an exact filename from list_stickers, or the same name without the .jpg extension.",
      inputSchema: {
        filename: z.string().min(1).describe("Sticker filename, e.g. 蹭蹭.jpg"),
      },
      outputSchema: {
        filename: z.string(),
        meaning: z.string(),
        tags: z.array(z.string()),
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
            text: `Sticker not found: ${filename}. Call list_stickers and use an existing filename.`,
          }],
        };
      }

      if (!String(sticker.path).toLowerCase().endsWith(".jpg")) {
        return {
          isError: true,
          content: [{
            type: "text",
            text: `Sticker ${sticker.filename} is not a JPG. The library should use JPG files for reliable ChatGPT display.`,
          }],
        };
      }

      const imageUrl = RAW_BASE + sticker.path.split("/").map(encodeURIComponent).join("/");
      const imageResponse = await fetch(imageUrl, {
        headers: { "user-agent": "yanzhou-stickers-mcp/0.1" },
      });
      if (!imageResponse.ok) throw new Error(`Could not load sticker image: HTTP ${imageResponse.status}`);

      const bytes = Buffer.from(await imageResponse.arrayBuffer());
      const base64 = bytes.toString("base64");
      const tags = Array.isArray(sticker.tags) ? sticker.tags : [];
      const meaning = sticker.meaning ?? "";

      return {
        structuredContent: {
          filename: sticker.filename,
          meaning,
          tags,
        },
        content: [
          {
            type: "image",
            data: base64,
            mimeType: "image/jpeg",
          },
          {
            type: "text",
            text: `${sticker.filename} — ${meaning}`,
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
