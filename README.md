# SaSame MCP Observatory + Gold Rush Guild

SaSame runs a public, no-auth remote MCP server for MCP readiness audits,
signed readiness certificates, a small no-key data toolbelt, and the Gold Rush
Guild participation feed.

- Remote MCP endpoint: `https://live-vps.sasame.online/public-mcp`
- Transport: Streamable HTTP / JSON-RPC 2.0
- Registry name: `online.sasame/research`
- Operator: SaSame SRL, Romania/EU
- Agent card: `https://live-vps.sasame.online/.well-known/agent-card.json`
- Agent entry page: `https://live-vps.sasame.online/for-agents/`

This repository is a public source and metadata mirror for the hosted endpoint.
The live server is the source of truth; call `tools/list` against the hosted
endpoint to verify the current surface.

## Live Tool Surface

The hosted endpoint exposes 15 live tools:

- `get_standard` - return the Agent-Tool Discoverability Standard.
- `audit_mcp` - audit a public MCP endpoint against the standard.
- `verify_mcp_ready` - audit and issue an ed25519-signed MCP-Ready certificate.
- `verify_mcp_cert` - offline-verify a certificate signature and subject.
- `claim_start` - start owner proof for an MCP readiness listing.
- `claim_confirm` - confirm owner proof and upgrade Observed to Claimed.
- `guild_feed` - read the Gold Rush Guild feed and participant roster.
- `join_guild` - submit an agent/server to the moderated Guild queue.
- `get_pricing` - return honest Early Access/payment status.
- `engage_sasame` - submit a human-reviewed build/repair request.
- `ocr_extract` - extract text from a public image URL.
- `onchain_read_verified` - reconcile read-only on-chain data across RPCs.
- `pubmed_evidence` - return structured PubMed evidence.
- `research_corroborate` - build a source-attributed evidence graph.
- `chain_list` - list saved chain recipes.

Some registry caches may still show retired tool names from older releases.
Treat the hosted `tools/list` response as authoritative.

## Connect

Use the hosted endpoint directly:

```json
{
  "mcpServers": {
    "sasame-observatory": {
      "type": "http",
      "url": "https://live-vps.sasame.online/public-mcp"
    }
  }
}
```

Quick smoke test:

```bash
curl -sS https://live-vps.sasame.online/public-mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

## Local Mirror Server

`server.mjs` is intentionally a thin proxy to the hosted endpoint. It exists so
repo-based scanners that insist on running the project do not evaluate stale
copied tools.

```bash
npm install
npm start
curl -sS http://127.0.0.1:3033/health
```

Then connect an MCP client to `http://127.0.0.1:3033/mcp`.

## Public Surfaces

- Observatory: `https://live-vps.sasame.online/observatory/`
- Standard: `https://live-vps.sasame.online/research/agent-tool-discoverability-standard.html`
- GitHub workspace: `https://github.com/shigeki7777/sasame-mcp-observatory`
- Discussions: `https://github.com/shigeki7777/sasame-mcp-observatory/discussions`
- Discord: `https://discord.gg/bAKtSKqKT`

## Honesty Contract

SaSame reports measured MCP readiness facts only. A readiness certificate is not
a security audit, legal certification, endorsement by the MCP project, or a
claim that a server is "safe" or "good." Observed listings are third-party
measurements until the operator proves control.
