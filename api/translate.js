// api/translate.js — Vercel Serverless Function
// FAST approach: extract all translatable segments → batch into chunks → translate → reassemble
// Result: 5-10 API calls per file instead of 200+

export const config = {
    api: { bodyParser: { sizeLimit: '5mb' } }
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─────────────────────────────────────────────
// MyMemory API — Free, no key needed
// Max 4800 chars per request
// ─────────────────────────────────────────────
async function myMemory(text, tl, retries = 3) {
    if (!text || !text.trim()) return text;
    if (/^[\s\d\W]+$/.test(text)) return text;

    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${encodeURIComponent('en|' + tl)}`;

    for (let attempt = 0; attempt < retries; attempt++) {
        try {
            const res = await fetch(url);

            if (res.status === 429 || res.status === 503) {
                await sleep(2000 * (attempt + 1));
                continue;
            }
            if (!res.ok) throw new Error(`HTTP ${res.status}`);

            const data = await res.json();

            if (data.responseStatus === 200 && data.responseData?.translatedText) {
                const t = data.responseData.translatedText;
                if (t.includes('MYMEMORY WARNING')) throw new Error('Quota reached');
                return t;
            }
            if (data.responseStatus === 429) throw new Error('Quota reached');
            return text;

        } catch (err) {
            console.error(`MyMemory attempt ${attempt + 1}:`, err.message);
            if (attempt < retries - 1) await sleep(1500 * (attempt + 1));
            else return text;
        }
    }
    return text;
}

// ─────────────────────────────────────────────
// STEP 1: Parse MD → extract segments
// Each segment = { type, prefix, text, suffix, index }
// type: 'translate' | 'skip'
// ─────────────────────────────────────────────
function parseMD(content) {
    const lines    = content.split('\n');
    const segments = []; // all segments in order
    let inFence    = false;
    let fenceCh    = '';

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Fenced code block
        const fm = line.match(/^(`{3,}|~{3,})/);
        if (fm) {
            if (!inFence) { inFence = true; fenceCh = fm[1]; }
            else if (line.startsWith(fenceCh)) { inFence = false; fenceCh = ''; }
            segments.push({ type: 'skip', raw: line + '\n' });
            continue;
        }
        if (inFence) { segments.push({ type: 'skip', raw: line + '\n' }); continue; }

        // Empty line
        if (!line.trim()) { segments.push({ type: 'skip', raw: '\n' }); continue; }

        // Horizontal rule
        if (/^[-*_]{3,}\s*$/.test(line.trim())) { segments.push({ type: 'skip', raw: line + '\n' }); continue; }

        // HTML comment
        if (line.trim().startsWith('<!--')) { segments.push({ type: 'skip', raw: line + '\n' }); continue; }

        // Heading
        const hm = line.match(/^(#{1,6})(\s+)(.+)/);
        if (hm) {
            segments.push({ type: 'translate', prefix: hm[1] + hm[2], text: hm[3], suffix: '\n' });
            continue;
        }

        // Blockquote (> Note: / > Tip: / > anything)
        if (/^>/.test(line)) {
            const bm = line.match(/^(>+\s*)(.*)/);
            if (bm && bm[2].trim()) {
                segments.push({ type: 'translate', prefix: bm[1], text: bm[2], suffix: '\n' });
            } else {
                segments.push({ type: 'skip', raw: line + '\n' });
            }
            continue;
        }

        // List item
        const lm = line.match(/^(\s*[-*+]\s+|\s*\d+\.\s+)(.*)/);
        if (lm) {
            segments.push({ type: 'translate', prefix: lm[1], text: lm[2], suffix: '\n' });
            continue;
        }

        // Normal line
        segments.push({ type: 'translate', prefix: '', text: line, suffix: '\n' });
    }

    return segments;
}

// ─────────────────────────────────────────────
// STEP 2: Pre-process inline tokens in each segment's text
// Replace `code`, URLs, ![img]() with placeholders
// Store them so we can restore after translation
// ─────────────────────────────────────────────
function tokenizeInline(text) {
    const tokens = [];
    const pat = /(`[^`\n]+`|!\[[^\]]*\]\([^\)]*\)|\[([^\]]+)\]\((https?:\/\/[^\)]+)\)|https?:\/\/[^\s\)\]"'<>]+)/g;
    let last = 0, m, out = '';

    pat.lastIndex = 0;
    while ((m = pat.exec(text)) !== null) {
        if (m.index > last) out += text.slice(last, m.index);
        const idx = tokens.length;

        if (m[2] !== undefined && m[3] !== undefined) {
            // [link text](url) — translate link text, keep url
            tokens.push({ type: 'link', linkText: m[2], url: m[3], original: m[0] });
            out += `__TK${idx}__`;
        } else {
            // inline code / image / bare URL — skip entirely
            tokens.push({ type: 'skip', original: m[0] });
            out += `__TK${idx}__`;
        }
        last = m.index + m[0].length;
    }
    if (last < text.length) out += text.slice(last);

    return { processedText: out, tokens };
}

// Restore tokens after translation
function restoreTokens(translated, tokens) {
    return translated.replace(/__TK(\d+)__/g, (_, i) => {
        const t = tokens[parseInt(i)];
        if (!t) return '';
        return t.type === 'link'
            ? `[${t.translatedLinkText || t.linkText}](${t.url})`
            : t.original;
    });
}

// ─────────────────────────────────────────────
// STEP 3: Batch all translatable text into chunks
// Separator between segments so we can split results
// ─────────────────────────────────────────────
const SEP = ' ||| '; // unique separator between segments

function buildBatches(translatableItems) {
    // translatableItems: [{ idx, text }]  (idx = position in translatableItems array)
    const batches = [];
    let current   = [];
    let currentLen = 0;

    for (const item of translatableItems) {
        const addLen = item.text.length + SEP.length;
        if (currentLen + addLen > 4500 && current.length > 0) {
            batches.push(current);
            current    = [];
            currentLen = 0;
        }
        current.push(item);
        currentLen += addLen;
    }
    if (current.length) batches.push(current);
    return batches;
}

// ─────────────────────────────────────────────
// STEP 4: Translate a batch — join with SEP, translate, split
// ─────────────────────────────────────────────
async function translateBatch(items, tl) {
    if (!items.length) return;

    const combined = items.map(i => i.text).join(SEP);
    const translated = await myMemory(combined, tl);

    // Split result — MyMemory may alter separator spacing slightly
    // Try exact split first, then fuzzy
    let parts = translated.split(SEP);

    if (parts.length !== items.length) {
        // Fuzzy split — try common variations
        const fuzzy = translated.split(/\s*\|\|\|\s*/);
        parts = fuzzy.length === items.length ? fuzzy : parts;
    }

    // Assign translations back
    items.forEach((item, i) => {
        item.translated = parts[i]?.trim() || item.text;
    });
}

// ─────────────────────────────────────────────
// MAIN: translate full MD content
// ─────────────────────────────────────────────
async function translateMarkdown(content, tl) {
    const segments = parseMD(content);

    // Pre-process: tokenize inline for each translatable segment
    const translatableItems = [];

    segments.forEach((seg, si) => {
        if (seg.type !== 'translate') return;
        const { processedText, tokens } = tokenizeInline(seg.text);
        seg._processedText = processedText;
        seg._tokens        = tokens;

        // Also handle **bold** / *italic* — replace with placeholders
        const bolds = [];
        const withBoldPH = processedText.replace(/(\*\*[^*\n]+\*\*|\*[^*\n]+\*)/g, (match) => {
            const bi  = bolds.length;
            const dbl = match.startsWith('**');
            bolds.push({ mk: dbl ? '**' : '*', inner: dbl ? match.slice(2,-2) : match.slice(1,-1) });
            return `__BD${bi}__`;
        });

        seg._bolds       = bolds;
        seg._withBoldPH  = withBoldPH;

        // Main segment text to translate
        translatableItems.push({ segIdx: si, text: withBoldPH, translated: null });

        // Each bold inner text also needs translation
        bolds.forEach((b, bi) => {
            translatableItems.push({ segIdx: si, boldIdx: bi, text: b.inner, translated: null });
        });

        // Each link text needs translation
        seg._tokens.forEach((tk, ti) => {
            if (tk.type === 'link') {
                translatableItems.push({ segIdx: si, tokenIdx: ti, text: tk.linkText, translated: null });
            }
        });
    });

    // Build batches and translate
    const batches = buildBatches(translatableItems);
    console.log(`Translating ${translatableItems.length} items in ${batches.length} API calls`);

    for (let b = 0; b < batches.length; b++) {
        await translateBatch(batches[b], tl);
        if (b < batches.length - 1) await sleep(300);
    }

    // Now write translated text back to link tokens and bold placeholders
    for (const item of translatableItems) {
        const seg = segments[item.segIdx];
        if (item.boldIdx !== undefined) {
            seg._bolds[item.boldIdx].translatedInner = item.translated || item.text;
        } else if (item.tokenIdx !== undefined) {
            seg._tokens[item.tokenIdx].translatedLinkText = item.translated || item.text;
        } else {
            seg._translatedMain = item.translated || item.text;
        }
    }

    // Reassemble file
    const output = segments.map(seg => {
        if (seg.type === 'skip') return seg.raw;

        // Restore bold/italic
        let text = (seg._translatedMain || seg._withBoldPH || seg._processedText || seg.text)
            .replace(/__BD(\d+)__/g, (_, i) => {
                const b = seg._bolds?.[parseInt(i)];
                if (!b) return '';
                return `${b.mk}${b.translatedInner || b.inner}${b.mk}`;
            });

        // Restore inline tokens
        text = restoreTokens(text, seg._tokens || []);

        return (seg.prefix || '') + text + (seg.suffix || '');
    });

    return output.join('');
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

        const translated  = await translateMarkdown(content, targetLang);
        const outFilename = filename.replace(/\.md$/i, '') + `_${targetLang}.md`;

        return res.status(200).json({ ok: true, translated, filename: outFilename });

    } catch (err) {
        console.error('Handler error:', err.message);
        return res.status(500).json({ error: err.message });
    }
}
