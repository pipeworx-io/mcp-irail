# mcp-irail

iRail MCP — Belgian rail (SNCB/NMBS) real-time via the community iRail API

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1394+ live data sources.

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

Or connect to the full Pipeworx gateway for access to all 1394+ data sources:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English:

```
ask_pipeworx({ question: "your question about Irail data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
