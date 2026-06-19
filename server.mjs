import express from "express";

const PORT = Number(process.env.PORT || 3033);
const HOST = process.env.HOST || "0.0.0.0";
const TARGET = process.env.SASAME_MCP_TARGET || "https://live-vps.sasame.online/public-mcp";
const UA = "sasame-mcp-mirror/0.6 (+https://github.com/shigeki7777/sasame-mcp)";

const app = express();
app.use(express.json({ limit: "1mb", type: "*/*" }));

function parseSseJson(text) {
  const data = text
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice(6))
    .join("\n")
    .trim();
  if (!data) return JSON.parse(text);
  return JSON.parse(data);
}

async function forwardMcp(req, res) {
  try {
    const upstream = await fetch(TARGET, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "accept": req.headers.accept || "application/json, text/event-stream",
        "user-agent": UA
      },
      body: JSON.stringify(req.body || {})
    });

    const contentType = upstream.headers.get("content-type") || "application/json";
    const body = await upstream.text();
    res.status(upstream.status).type(contentType).send(body);
  } catch (error) {
    res.status(502).json({
      jsonrpc: "2.0",
      id: req.body?.id ?? null,
      error: {
        code: -32000,
        message: `SaSame hosted MCP unavailable: ${String(error?.message || error).slice(0, 160)}`
      }
    });
  }
}

app.post("/mcp", forwardMcp);
app.post("/public-mcp", forwardMcp);

app.get("/health", async (_req, res) => {
  try {
    const upstream = await fetch(TARGET, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "accept": "application/json, text/event-stream",
        "user-agent": UA
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
    });
    const parsed = parseSseJson(await upstream.text());
    const tools = parsed?.result?.tools?.map((tool) => tool.name) || [];
    res.json({ ok: upstream.ok, proxy: true, target: TARGET, tools_exposed: tools.length, tools });
  } catch (error) {
    res.status(502).json({ ok: false, proxy: true, target: TARGET, error: String(error?.message || error) });
  }
});

app.get("/", (_req, res) => {
  res.json({
    name: "online.sasame/research",
    description: "Thin local proxy for the hosted SaSame MCP Observatory + Gold Rush Guild endpoint.",
    target: TARGET,
    mcp: "/mcp",
    health: "/health"
  });
});

app.listen(PORT, HOST, () => {
  console.log(`sasame-mcp mirror proxy listening on http://${HOST}:${PORT}/mcp -> ${TARGET}`);
});
