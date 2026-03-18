// api/translate.js — Vercel Serverless Function
// MyMemory API: Free, no card, no API key
// Each file is one POST request — frontend runs 3 files in parallel

export const config = {
    api: { bodyParser: { sizeLimit: '5mb' } }
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─────────────────────────────────────────────
// MyMemory — free translation API
// 5000 chars/request limit
// ─────────────────────────────────────────────
async function myMemory(text, tl, retries = 3) {
    if (!text || !text.trim()) return text;
    if (/^[\s\d\W]+$/.test(text)) return text;

    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${encodeURIComponent('en|' + tl)}`;

    for (let attempt = 0; attempt < retries; attempt++) {
        try {
            const res  = await fetch(url);
            if (res.status === 429 || res.status === 503) { await sleep(2000 * (attempt + 1)); continue; }
            if (!res.ok) throw new Error(`MyMemory HTTP ${res.status}`);

            const data = await res.json();
            if (data.responseStatus === 200 && data.responseData?.translatedText) {
                const t = data.responseData.translatedText;
                if (t.includes('MYMEMORY WARNING')) throw new Error('Quota reached');
                return t;
            }
            if (data.responseStatus === 429) throw new Error('Quota reached');
            return text;
        } catch (err) {
            if (attempt < retries - 1) await sleep(1500 * (attempt + 1));
            else return text; // return original on failure — never break the file
        }
    }
    return text;
}

// ─────────────────────────────────────────────
// Translate text — splits if > 4800 chars
// ─────────────────────────────────────────────
async function tx(text, tl) {
    if (!text || !text.trim()) return text;
    if (text.length <= 4800) return myMemory(text, tl);

    // chunk by sentence
    const sentences = text.match(/[^.!?\n]+[.!?\n]*/g) || [text];
    const chunks = [];
    let cur = '';
    for (const s of sentences) {
        if ((cur + s).length > 4800) { if (cur) chunks.push(cur.trim()); cur = s; }
        else cur += s;
    }
    if (cur.trim()) chunks.push(cur.trim());

    const out = [];
    for (const c of chunks) { out.push(await myMemory(c, tl)); await sleep(200); }
    return out.join(' ');
}

// ─────────────────────────────────────────────
// Translate inline content
// SKIP : `code`  https://url  ![img]()
// KEEP url, translate link text: [text](url)
// ─────────────────────────────────────────────
async function txInline(text, tl) {
    if (!text || !text.trim()) return text;

    const pat = /(`[^`\n]+`|!\[[^\]]*\]\([^\)]*\)|\[([^\]]+)\]\((https?:\/\/[^\)]+)\)|https?:\/\/[^\s\)\]"'<>]+)/g;
    const parts = [];
    let last = 0, m;
    pat.lastIndex = 0;

    while ((m = pat.exec(text)) !== null) {
        if (m.index > last) parts.push({ k: 'tx', t: text.slice(last, m.index) });
        // [link text](url)
        if (m[2] !== undefined && m[3] !== undefined)
            parts.push({ k: 'link', lt: m[2], url: m[3] });
        else
            parts.push({ k: 'skip', t: m[0] });
        last = m.index + m[0].length;
    }
    if (last < text.length) parts.push({ k: 'tx', t: text.slice(last) });

    let out = '';
    for (const p of parts) {
        if      (p.k === 'skip') out += p.t;
        else if (p.k === 'link') out += `[${await tx(p.lt, tl)}](${p.url})`;
        else                     out += p.t.trim() ? await txBoldItalic(p.t, tl) : p.t;
    }
    return out;
}

// ─────────────────────────────────────────────
// Preserve **bold** / *italic* during translation
// ─────────────────────────────────────────────
async function txBoldItalic(text, tl) {
    if (!text.trim()) return text;
    const ph = [];
    let processed = text.replace(/(\*\*[^*\n]+\*\*|\*[^*\n]+\*)/g, (match) => {
        const i   = ph.length;
        const dbl = match.startsWith('**');
        const mk  = dbl ? '**' : '*';
        ph.push({ mk, inner: dbl ? match.slice(2,-2) : match.slice(1,-1) });
        return `XLPH${i}X`;
    });

    let main = await tx(processed, tl);

    for (let i = 0; i < ph.length; i++) {
        const inner = await tx(ph[i].inner, tl);
        main = main.replace(new RegExp(`XLPH${i}X`, 'g'), `${ph[i].mk}${inner}${ph[i].mk}`);
    }
    return main;
}

// ─────────────────────────────────────────────
// Markdown parser + translator
// Preserves all structure, skips code blocks
// ─────────────────────────────────────────────
async function translateMD(content, tl) {
    const lines  = content.split('\n');
    const output = [];
    let inFence  = false;
    let fenceCh  = '';

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // ── Fenced code block (``` or ~~~) ──
        const fm = line.match(/^(`{3,}|~{3,})/);
        if (fm) {
            if (!inFence) { inFence = true;  fenceCh = fm[1]; }
            else if (line.startsWith(fenceCh)) { inFence = false; fenceCh = ''; }
            output.push(line); continue;
        }
        if (inFence) { output.push(line); continue; }

        // ── Empty line ──
        if (!line.trim()) { output.push(''); continue; }

        // ── Horizontal rule ──
        if (/^[-*_]{3,}\s*$/.test(line.trim())) { output.push(line); continue; }

        // ── HTML comment ──
        if (line.trim().startsWith('<!--')) { output.push(line); continue; }

        // ── Headings: # ## ### #### ##### ###### ──
        const hm = line.match(/^(#{1,6})(\s+)(.+)/);
        if (hm) {
            output.push(`${hm[1]}${hm[2]}${await txInline(hm[3], tl)}`);
            await sleep(100); continue;
        }

        // ── Blockquote: > Note: / > Tip: / > Important: / > Caution: / > anything ──
        if (/^>/.test(line)) {
            const bm = line.match(/^(>+\s*)(.*)/);
            if (bm && bm[2].trim()) output.push(`${bm[1]}${await txInline(bm[2], tl)}`);
            else                    output.push(line);
            await sleep(100); continue;
        }

        // ── List items: - * + 1. 2. ──
        const lm = line.match(/^(\s*[-*+]\s+|\s*\d+\.\s+)(.*)/);
        if (lm) {
            output.push(`${lm[1]}${await txInline(lm[2], tl)}`);
            await sleep(100); continue;
        }

        // ── Normal paragraph ──
        output.push(await txInline(line, tl));
        await sleep(100);
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

        console.log(`▶ ${filename} → ${targetLang} (${content.length} chars)`);

        const translated  = await translateMD(content, targetLang);
        const outFilename = filename.replace(/\.md$/i, '') + `_${targetLang}.md`;

        return res.status(200).json({ ok: true, translated, filename: outFilename });

    } catch (err) {
        console.error('Handler error:', err.message);
        return res.status(500).json({ error: err.message });
    }
}
