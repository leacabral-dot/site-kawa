// Contrôle si la configuration Gemini est présente (ne dévoile pas la clé).
export const config = { path: '/api/health' };
export default async function handler(req) {
  if (req.method !== 'GET') return new Response('Méthode non autorisée', { status: 405 });
  return Response.json({ ai_enabled: Boolean(process.env.GEMINI_API_KEY) }, {
    headers: { 'Cache-Control': 'no-store' }
  });
}
