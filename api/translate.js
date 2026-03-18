// api/translate.js — Vercel Serverless Function
// Fixed: translate each line individually — no separator batching issues
// MyMemory API: Free, no key needed

export const config = {
    api: { bodyParser: { sizeLimit: '5mb' } }
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─────────────────────────────────────────────
// MyMemory language code map
// Some codes need to be different for MyMemory
// ─────────────────────────────────────────────
const LANG_MAP = {
    'zh-CN': 'zh',
    'zh-TW': 'zh-TW',
    'iw':    'he',   // Hebrew
    'jw':    'jv',   // Javanese
};

function toMyMemoryCode(code) {
    return LANG_MAP[code] || code;
}

// ─────────────────────────────────────────────
// MyMemory API call — single text
// ─────────────────────────────────────────────
async function myMemory(text, tl, retries = 3) {
    if (!text || !text.trim()) return text;
    // Skip pure symbols/numbers/whitespace
    if (/^[\s\d\W]+$/.test(text)) return text;

    const langCode = toMyMemoryCode(tl);
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${encodeURIComponent('en|' + langCode)}`;

    for (let attempt = 0; attempt < retries; attempt++) {
        try {
            const res = await fetch(url);

            if (res.status === 429 || res.status === 503) {
                await sleep(2500 * (attempt + 1));
                continue;
            }
            if (!res.ok) throw new Error(`HTTP ${res.status}`);

            const data = await res.json();

            // responseStatus 200 = success
            if (data.responseStatus === 200 && data.responseData?.translatedText) {
                const t = data.responseData.translatedText;
                if (t.includes('MYMEMORY WARNING')) {
                    console.warn('MyMemory quota warning');
                    throw new Error('Quota reached');
                }
                return t;
            }

            if (data.responseStatus === 429) throw new Error('Quota reached');

            // Any other status — return original
            return text;

        } catch (err) {
            console.error(`MyMemory attempt ${attempt + 1} [${tl}]:`, err.message);
            if (attempt < retries - 1) await sleep(1500 * (attempt + 1));
            else return text; // return original on final failure — never break the file
        }
    }
    return text;
}

// ─────────────────────────────────────────────
// Translate text — handles long text by splitting
// ─────────────────────────────────────────────
async function translateText(text, tl) {
    if (!text || !text.trim()) return text;

    // Short enough — translate directly
    if (text.length <= 4500) {
        return await myMemory(text, tl);
    }

    // Long text — split into sentences
    const sentences = text.match(/[^.!?\n]+[.!?\n]*/g) || [text];
    const chunks = [];
    let cur = '';
    for (const s of sentences) {
        if ((cur + s).length > 4500) {
            if (cur) chunks.push(cur.trim());
            cur = s;
        } else {
            cur += s;
        }
    }
    if (cur.trim()) chunks.push(cur.trim());

    const results = [];
    for (const chunk of chunks) {
        results.push(await myMemory(chunk, tl));
        await sleep(200);
    }
    return results.join(' ');
}

// ─────────────────────────────────────────────
// Inline content translator
// SKIP: `code`, URLs, images
// Translate: text, link text
// Preserve: **bold**, *italic* markers
// ─────────────────────────────────────────────
async function translateInline(text, tl) {
    if (!text || !text.trim()) return text;

    // Tokenize — find parts to skip
    const pat = /(`[^`\n]+`|!\[[^\]]*\]\([^\)]*\)|\[([^\]]+)\]\((https?:\/\/[^\)]+)\)|https?:\/\/[^\s\)\]"'<>]+)/g;
    const parts = [];
    let last = 0, m;

    pat.lastIndex = 0;
    while ((m = pat.exec(text)) !== null) {
        if (m.index > last) parts.push({ k: 'tx', t: text.slice(last, m.index) });
        if (m[2] !== undefined && m[3] !== undefined) {
            // [link text](url) — translate link text, keep url
            parts.push({ k: 'link', lt: m[2], url: m[3] });
        } else {
            // inline code / image / bare URL — keep as-is
            parts.push({ k: 'skip', t: m[0] });
        }
        last = m.index + m[0].length;
    }
    if (last < text.length) parts.push({ k: 'tx', t: text.slice(last) });

    let out = '';
    for (const p of parts) {
        if (p.k === 'skip') {
            out += p.t;
        } else if (p.k === 'link') {
            const translatedLinkText = await translateText(p.lt, tl);
            out += `[${translatedLinkText}](${p.url})`;
        } else {
            // Translate — preserve **bold** and *italic*
            out += p.t.trim() ? await translatePreservingMarkers(p.t, tl) : p.t;
        }
    }
    return out;
}

// ─────────────────────────────────────────────
// Preserve **bold** / *italic* markers
// Replace with placeholders → translate → restore
// ─────────────────────────────────────────────
async function translatePreservingMarkers(text, tl) {
    if (!text.trim()) return text;

    const markers = [];
    // Replace **bold** and *italic* with safe placeholders
    let processed = text.replace(/(\*\*[^*\n]+\*\*|\*[^*\n]+\*)/g, (match) => {
        const i   = markers.length;
        const dbl = match.startsWith('**');
        const mk  = dbl ? '**' : '*';
        const inner = dbl ? match.slice(2, -2) : match.slice(1, -1);
        markers.push({ mk, inner });
        return `MKPH${i}END`;
    });

    // Translate main text with placeholders
    const translatedMain = await translateText(processed, tl);

    // Translate each marker's inner text and restore
    let result = translatedMain;
    for (let i = 0; i < markers.length; i++) {
        const { mk, inner } = markers[i];
        const translatedInner = await translateText(inner, tl);
        // Replace placeholder — handle if translation slightly modified it
        result = result.replace(new RegExp(`MKPH${i}END`, 'g'), `${mk}${translatedInner}${mk}`);
    }

    return result;
}

// ─────────────────────────────────────────────
// MD Parser + Translator
// Line by line — fully reliable
// ─────────────────────────────────────────────
async function translateMarkdown(content, tl) {
    const lines  = content.split('\n');
    const output = [];
    let inFence  = false;
    let fenceCh  = '';

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // ── Fenced code block ──
        const fm = line.match(/^(`{3,}|~{3,})/);
        if (fm) {
            if (!inFence) { inFence = true;  fenceCh = fm[1]; }
            else if (line.startsWith(fenceCh)) { inFence = false; fenceCh = ''; }
            output.push(line);
            continue;
        }
        if (inFence) { output.push(line); continue; }

        // ── Empty line ──
        if (!line.trim()) { output.push(''); continue; }

        // ── Horizontal rule ──
        if (/^[-*_]{3,}\s*$/.test(line.trim())) { output.push(line); continue; }

        // ── HTML comment ──
        if (line.trim().startsWith('<!--')) { output.push(line); continue; }

        // ── Heading: # ## ### #### ##### ###### ──
        const hm = line.match(/^(#{1,6})(\s+)(.+)/);
        if (hm) {
            const translated = await translateInline(hm[3], tl);
            output.push(`${hm[1]}${hm[2]}${translated}`);
            await sleep(120);
            continue;
        }

        // ── Blockquote: > Note: / > Tip: / > Important: / > Caution: / > anything ──
        if (/^>/.test(line)) {
            const bm = line.match(/^(>+\s*)(.*)/);
            if (bm && bm[2].trim()) {
                const translated = await translateInline(bm[2], tl);
                output.push(`${bm[1]}${translated}`);
            } else {
                output.push(line);
            }
            await sleep(120);
            continue;
        }

        // ── List item: - * + 1. 2. ──
        const lm = line.match(/^(\s*[-*+]\s+|\s*\d+\.\s+)(.*)/);
        if (lm) {
            const translated = await translateInline(lm[2], tl);
            output.push(`${lm[1]}${translated}`);
            await sleep(120);
            continue;
        }

        // ── Normal paragraph line ──
        const translated = await translateInline(line, tl);
        output.push(translated);
        await sleep(120);
    }

    return output.join('\n');
}

// ─────────────────────────────────────────────
// HANDLER
// ─────────────────────────────────────────────
export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin',  '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') { res.status(200).end(); return; }
    if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

    try {
        const { content, filename, targetLang } = req.body;

        if (!content    || typeof content    !== 'string') return res.status(400).json({ error: 'content is required' });
        if (!targetLang || typeof targetLang !== 'string') return res.status(400).json({ error: 'targetLang is required' });
        if (!filename   || typeof filename   !== 'string') return res.status(400).json({ error: 'filename is required' });

        console.log(`▶ Translating: "${filename}" → ${targetLang} (${content.length} chars)`);

        const translated  = await translateMarkdown(content, targetLang);
        const outFilename = filename.replace(/\.md$/i, '') + `_${targetLang}.md`;

        console.log(`✓ Done: "${outFilename}"`);

        return res.status(200).json({ ok: true, translated, filename: outFilename });

    } catch (err) {
        console.error('Handler error:', err.message);
        return res.status(500).json({ error: err.message });
    }
}
