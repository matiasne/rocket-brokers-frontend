import { MCP_AUTH_URL, MCP_TOOLS_URL, MCP_URL } from '@/lib/mcp'

// The MCP front door: its endpoint, the tools it publishes and who signs the borrower in.
// `tools` is null while the router is unreachable; `issuer` is null while the door takes no token.
export async function GET() {
  const [tools, auth] = await Promise.all([
    fetch(MCP_TOOLS_URL, { cache: 'no-store' })
      .then(res => (res.ok ? res.json() : null))
      .then(body => (Array.isArray(body?.tools) ? body.tools.map((tool: { name: string }) => tool.name) : null))
      .catch(() => null),
    fetch(MCP_AUTH_URL, { cache: 'no-store' })
      .then(res => (res.ok ? res.json() : null))
      .catch(() => null),
  ])
  // With sign-in on, the router knows its public address: the one a client outside this machine uses.
  return Response.json({ url: auth?.resource ?? MCP_URL, tools, issuer: auth?.authorization_servers?.[0] ?? null })
}
