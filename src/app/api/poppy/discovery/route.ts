import { DISCOVERY_URL } from '@/lib/poppy'

// PAP discovery: the company's poppy.json. `document` is null while the router is unreachable.
export async function GET() {
  const document = await fetch(DISCOVERY_URL, { cache: 'no-store' })
    .then(res => (res.ok ? res.json() : null))
    .catch(() => null)
  return Response.json({ url: DISCOVERY_URL, document })
}
