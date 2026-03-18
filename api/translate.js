// api/translate.js — Vercel Serverless Function
// Minimal: just validates request — actual translation happens in browser
// This keeps the API alive for future use (e.g. quota check)

export const config = {
    api: { bodyParser: { sizeLimit: '1kb' } }
};

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin',  '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.status(200).end(); return; }
    // Translation is handled client-side
    return res.status(200).json({ ok: true, message: 'Translation handled client-side' });
}
