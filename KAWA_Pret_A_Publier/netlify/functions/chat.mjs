// KAWA / KAWI : passerelle serveur -> Gemini (cle jamais exposee dans le site).
// Projet scolaire : protections simples ; pour une large audience ajouter un vrai rate-limit persistant et un CAPTCHA.
import { KAWI_PROMPT } from './kawi-prompt.mjs';

export const config = { path: '/api/chat' };

const FREE_MODELS = ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-2.5-flash-lite'];
let preferredModel = '';
let modelCheckedAt = 0;
const attempts = new Map(); // limite indicative par instance (non globale sur Netlify)
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }
});

async function selectModel(apiKey) {
  if (preferredModel && Date.now() - modelCheckedAt < 15 * 60 * 1000) return preferredModel;
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000', {
      headers: { 'x-goog-api-key': apiKey }, signal: ctrl.signal
    });
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) throw new Error(`Clé Gemini refusée ou non autorisée (${res.status}). Vérifie Google AI Studio.`);
      throw new Error(`Impossible de vérifier les modèles Gemini (erreur ${res.status}).`);
    }
    const data = await res.json();
    const names = new Set((data.models || []).filter(m => m.supportedGenerationMethods?.includes('generateContent')).map(m => String(m.name || '').split('/').pop()));
    const model = FREE_MODELS.find(name => names.has(name));
    if (!model) throw new Error('Aucun modèle Gemini compatible avec la version gratuite n’est accessible avec cette clé.');
    preferredModel = model;
    modelCheckedAt = Date.now();
    return model;
  } finally { clearTimeout(timeout); }
}

export default async function handler(req) {
  if (req.method !== 'POST') return json({ error: 'Méthode non autorisée.' }, 405);
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return json({ error: 'Clé Gemini absente : ajoute GEMINI_API_KEY dans les variables de Netlify, puis redéploie le site.' }, 503);

  // Limite raisonnable pour un site de demonstration, par instance de fonction.
  const ip = req.headers.get('x-nf-client-connection-ip') || req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'anonymous';
  const now = Date.now();
  const previous = (attempts.get(ip) || []).filter(time => now - time < 60 * 60 * 1000);
  if (previous.length >= 25) return json({ error: 'Trop de messages pour le moment : reviens dans une heure.' }, 429);
  previous.push(now);
  attempts.set(ip, previous);
  if (attempts.size > 2500) attempts.clear();

  let messages;
  try {
    const raw = await req.text();
    if (raw.length > 24000) return json({ error: 'Message trop long.' }, 413);
    const payload = JSON.parse(raw);
    messages = payload.messages;
    if (!Array.isArray(messages) || messages.length < 1 || messages.length > 14 || messages.at(-1)?.role !== 'user' || !messages.every(m =>
      m && ['user', 'assistant'].includes(m.role) && typeof m.content === 'string' && m.content.trim().length >= 1 && m.content.length <= 1000
    )) return json({ error: 'Conversation invalide.' }, 400);
  } catch { return json({ error: 'Format de question invalide.' }, 400); }

  try {
    const model = await selectModel(apiKey);
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 26000);
    let res;
    try {
      res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: KAWI_PROMPT }] },
          contents: messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
          generationConfig: { maxOutputTokens: 1200, temperature: 0.4 }
        }),
        signal: ctrl.signal
      });
    } finally { clearTimeout(timeout); }
    if (!res.ok) {
      if (res.status === 429) return json({ error: 'Quota gratuit Gemini atteint. Réessaie plus tard ou consulte les quotas du projet.' }, 429);
      if (res.status === 404) return json({ error: `Le modèle ${model} n’est pas accessible pour cette clé (404).` }, 502);
      if (res.status === 401 || res.status === 403) return json({ error: 'La clé Gemini est refusée ou le projet n’est pas autorisé.' }, 502);
      return json({ error: `Gemini est temporairement indisponible (erreur ${res.status}).` }, 502);
    }
    const data = await res.json();
    const reply = (data.candidates?.[0]?.content?.parts || []).map(part => typeof part.text === 'string' ? part.text : '').join('\n').trim();
    if (!reply) return json({ error: 'Gemini n’a pas renvoyé de réponse.' }, 502);
    return json({ reply });
  } catch (err) {
    const msg = err?.name === 'AbortError' ? 'Le service Gemini met trop de temps à répondre.' : String(err?.message || 'Erreur de connexion à Gemini.');
    return json({ error: msg.slice(0, 220) }, 502);
  }
}
