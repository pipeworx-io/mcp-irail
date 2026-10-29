# mcp-irail

iRail MCP — Belgian rail (SNCB/NMBS) real-time via the community iRail API (https://api.irail.be, keyless, https://docs.irail.be)

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1856+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Tools

| Tool | Description |
|------|-------------|
| `irail_liveboard` | Live departures board at a Belgian train station — Belgian train times SNCB NMBS. Brussels Antwerp Ghent departures with train number, destination, scheduled time, delay in minutes, platform, and canceled flag. Set type to "arrival" for the arrivals board. Station names accept English exonyms and fuzzy input ("Brussels-South", "Antwerp-Central", "Liège-Guillemins"). Example: irail_liveboard({ station: "Brussels-South" }) |
| `irail_journey` | Plan a train journey between two Belgian stations — SNCB NMBS route planner with legs, transfers, live delays, and platforms per leg. Answers "next train from Brussels to Antwerp", "how do I get from Ghent to Liège by rail". Optional depart_at or arrive_by as ISO datetime ("2026-07-20T09:00") or time ("09:00"), interpreted in Belgian local time. Example: irail_journey({ from: "Brussels-South", to: "Antwerp-Central" }) |
| `irail_train` | Track one Belgian train by its number — is my Belgian train delayed. All stops with scheduled vs actual times, per-stop delay in minutes, platforms, current delay, and live position. Accepts "IC 1832", "IC1832", or "BE.NMBS.IC1832". Train numbers come from irail_liveboard or irail_journey. Example: irail_train({ id: "IC1832" }) |
| `irail_disturbances` | Current disturbances, incidents, and planned works on the Belgian rail network (SNCB NMBS Infrabel) — strikes, track works, line closures affecting Belgian train service. Returns title, summary, type (planned or disturbance), link, and last-updated time. Example: irail_disturbances({}) |

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "irail": {
      "url": "https://gateway.pipeworx.io/irail/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/irail/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1856+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/irail_liveboard \
  -H 'Content-Type: application/json' \
  -d '{"station":"Brussels-South"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/irail_liveboard`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Run it from npm

`@pipeworx/mcp-irail` is a local stdio bridge to the Pipeworx gateway: your MCP client
starts it with `npx`, and it forwards every call to the same
`https://gateway.pipeworx.io/irail/mcp` endpoint shown above. It needs network access;
there is no offline mode.

```json
{
  "mcpServers": {
    "irail": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-irail"]
    }
  }
}
```

Without a key it calls anonymously, capped at 50 calls a day. A free account
raises that to 200 a day: get a key at https://pipeworx.io/signup and add
`"env": { "PIPEWORX_API_KEY": "<your key>" }` to the server entry.
The key is sent as a Bearer token, the same way a hosted connection sends it,
so calls are metered and billed exactly as they are there.

It lists **only** this pack's tools by default. Set `PIPEWORX_META_TOOLS=1` to
also list `ask_pipeworx` and the other gateway-wide tools.

Behind an HTTPS proxy: Node's built-in `fetch` does not read `HTTPS_PROXY` by
default. Newer Node releases honour it when `NODE_USE_ENV_PROXY=1` is set; check
your Node version's documentation.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Irail data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
