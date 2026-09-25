# Yanzhou Stickers MCP

A tiny read-only MCP server for the `2824076509-collab/yanzhou-stickers` sticker library.

Tools:
- `list_stickers`: returns filenames, meanings, and tags from `stickers.json`.
- `show_sticker`: fetches the selected `.jpg` from the repository and returns the JPEG bytes as MCP image content.

Run locally:

```bash
npm install
npm start
```

The MCP endpoint is `http://localhost:8787/mcp`.

For ChatGPT, deploy this directory to a stable HTTPS Node host, then connect `https://YOUR-HOST/mcp` in Developer mode.
