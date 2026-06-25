const functions = require("firebase-functions");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const { FieldValue } = require("firebase-admin/firestore");
const { OpenAI } = require("openai");
const pdf = require("pdf-parse");
const express = require("express");
const cors = require("cors");

// Declare the secret (stored in Firebase Secret Manager)
const openaiApiKey = defineSecret("OPENAI_API_KEY");

// Runtime options for heavy functions
const runtimeOpts = { timeoutSeconds: 300, memory: '1GB', secrets: ['OPENAI_API_KEY'] };

// Initialize Firebase Admin (no credentials needed inside Cloud Functions!)
admin.initializeApp();
const db = admin.firestore();
const bucket = admin.storage().bucket();

// Helper to get OpenAI client (called inside functions where secret is available)
function getOpenAI() {
    return new OpenAI({ apiKey: openaiApiKey.value().trim() });
}

// =============================================================================
// HELPER FUNCTIONS (shared logic from server.js)
// =============================================================================

function cosineSimilarity(vecA, vecB) {
    let dotProduct = 0.0, normA = 0.0, normB = 0.0;
    for (let i = 0; i < vecA.length; i++) {
        dotProduct += vecA[i] * vecB[i];
        normA += vecA[i] * vecA[i];
        normB += vecB[i] * vecB[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

function scaleConfidence(similarity) {
    if (similarity <= 0.2) return Math.round(similarity * 100);
    if (similarity <= 0.3) return Math.round(20 + (similarity - 0.2) * 300);
    if (similarity <= 0.5) return Math.round(50 + (similarity - 0.3) * 150);
    if (similarity <= 0.7) return Math.round(80 + (similarity - 0.5) * 100);
    return 100;
}

function parseLimitToLakh(raw) {
    if (!raw) return 0;
    let s = raw.toString().toUpperCase()
        .replace(/RS\.?\s*/g, '').replace(/UPTO\s*/g, '').replace(/,/g, '')
        .replace(/[.]+$/, '').trim();
    if (!s || s === '-' || s === 'NIL') return 0;
    if (s.includes('FULL') || s.includes('POWER')) return Infinity;
    s = s.replace(/\bSO\b/g, '50')
         .replace(/\bS(\d)/g, '5$1')
         .replace(/(\d)[O]/gi, '$10')
         .replace(/[O](\d)/gi, '0$1')
         .replace(/[O]\b/g, '0');
    s = s.replace(/LAKHSH?|1AKH|LAKH/gi, 'LAKH').replace(/CRORE|CR\b/gi, 'CRORE')
         .replace(/\s+/g, ' ').trim();
    let m;
    m = s.match(/^([\d.]+)\s*CRORE$/i); if (m) return parseFloat(m[1]) * 100;
    m = s.match(/^([\d.]+)\s*LAKH$/i);  if (m) return parseFloat(m[1]);
    m = s.match(/^([\d.]+)$/);           if (m) return parseFloat(m[1]);
    return 0;
}

function extractTargetAmountLakh(question) {
    const q = question.toLowerCase()
        .replace(/,/g, '')
        .replace(/(?:रुपये|रुपए|रुपया|रु\.?|रू\.?)/g, 'rs')
        .replace(/(?:लाख|ल\b)/g, 'lakh')
        .replace(/(?:करोड़|करोड|सीआर\b)/g, 'crore')
        .replace(/(?:क्लॉज|क्लाज|धारा)/g, 'clause');
    const unitRegex = /(\d+(?:\.\d+)?)\s*(crore|cr|lakh|l)\b/gi;
    let match;
    unitRegex.lastIndex = 0;
    if ((match = unitRegex.exec(q)) !== null) {
        const val = parseFloat(match[1]);
        const unit = match[2].toLowerCase();
        return unit.startsWith('c') ? val * 100 : val;
    }
    const rsRegex = /rs\.?\s*(\d+(?:\.\d+)?)\b/gi;
    rsRegex.lastIndex = 0;
    if ((match = rsRegex.exec(q)) !== null) {
        const val = parseFloat(match[1]);
        return val >= 10000 ? val / 100000 : val;
    }
    let temp = q.replace(/\b\d+\.\d+\b/g, '');
    const anyNumRegex = /\b(\d+(?:\.\d+)?)\b/g;
    if ((match = anyNumRegex.exec(temp)) !== null) {
        const val = parseFloat(match[1]);
        return val >= 10000 ? val / 100000 : val;
    }
    return null;
}

const AUTHORITY_NAMES = {
    SM: 'Senior Manager (SM)', DGM: 'Deputy General Manager (DGM)',
    AGM: 'Additional General Manager (AGM)', GM: 'General Manager (GM)',
    ED: 'Executive Director (ED)'
};
const AUTHORITY_ORDER = ['SM', 'DGM', 'AGM', 'GM', 'ED'];

function extractClauseRow(chunks, clauseNumber) {
    const siRe = new RegExp(`\\[SI:\\s*${clauseNumber.replace('.', '\\.')}[\\s\\]|]`, 'i');
    for (const chunk of chunks) {
        for (const line of (chunk.text || '').split('\n')) {
            if (!siRe.test(line)) continue;
            const extract = (key) => {
                const m = line.match(new RegExp(`\\[${key}:\\s*([^\\]]+)\\]`, 'i'));
                return m ? m[1].trim() : null;
            };
            const row = { Nature: extract('Nature of Power'), ED: extract('ED'),
                GM: extract('GM'), AGM: extract('AGM'), DGM: extract('DGM'), SM: extract('SM') };
            if (row.ED || row.GM || row.AGM || row.DGM || row.SM) return row;
        }
    }
    return null;
}

function resolveAuthority(clauseRow, targetLakh) {
    for (const key of AUTHORITY_ORDER) {
        const limitLakh = parseLimitToLakh(clauseRow[key] || '');
        if (limitLakh >= targetLakh)
            return { key, name: AUTHORITY_NAMES[key], limitLakh, limitText: clauseRow[key] || '' };
    }
    const last = AUTHORITY_ORDER[AUTHORITY_ORDER.length - 1];
    return { key: last, name: AUTHORITY_NAMES[last], limitLakh: Infinity, limitText: 'Full Powers' };
}

function formatAnswer(text) {
    if (!text) return "";
    return text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
}

// Custom PDF parser with dynamic column detection (same as server.js)
async function parsePdfPages(buffer) {
    let pagesText = [];
    function toColKey(text) {
        const t = text.toUpperCase().replace(/[\s.]/g, '');
        if (t === 'ED') return 'ED'; if (t === 'GM') return 'GM';
        if (t === 'AGM') return 'AGM'; if (t === 'DGM') return 'DGM';
        if (t === 'SM') return 'SM'; return null;
    }
    function isHeaderRow(items) {
        const norm = items.map(it => it.text.toUpperCase().replace(/[\s.]/g, ''));
        return norm.some(t => t === 'ED') && norm.some(t => t === 'GM') && norm.some(t => t === 'AGM');
    }
    const COLS = ['SI', 'Nature', 'ED', 'GM', 'AGM', 'DGM', 'SM'];
    function render_page(pageData) {
        return pageData.getTextContent({ normalizeWhitespace: true, disableCombineTextItems: false })
            .then(function(textContent) {
                const items = textContent.items;
                if (items.length === 0) { pagesText.push(''); return ''; }
                const yTol = 3;
                let lines = [];
                for (const item of items) {
                    const x = item.transform[4], y = item.transform[5];
                    const text = item.str;
                    const fl = lines.find(l => Math.abs(l.y - y) <= yTol);
                    if (fl) fl.items.push({ text, x, y });
                    else lines.push({ y, items: [{ text, x, y }] });
                }
                lines.sort((a, b) => b.y - a.y);
                let rows = [], curRow = null;
                for (const line of lines) {
                    line.items.sort((a, b) => a.x - b.x);
                    const startsRow = line.items.some(it => it.x < 100);
                    if (startsRow || !curRow) {
                        curRow = { y: line.y, items: [...line.items] };
                        rows.push(curRow);
                    } else {
                        curRow.items.push(...line.items);
                    }
                }
                let colX = { SI: 50, Nature: 180, ED: 275, GM: 322, AGM: 370, DGM: 425, SM: 480 };
                const fmtBucket = (bucket) => {
                    bucket.sort((a, b) => Math.abs(a.y - b.y) > 2 ? b.y - a.y : a.x - b.x);
                    return bucket.map(it => it.text).join(' ').replace(/\s+/g, ' ').trim();
                };
                let out = [];
                for (const row of rows) {
                    const sorted = [...row.items].sort((a, b) => a.x - b.x);
                    if (isHeaderRow(sorted)) {
                        const newX = {};
                        for (const it of sorted) {
                            const k = toColKey(it.text);
                            if (k && newX[k] === undefined) newX[k] = it.x;
                        }
                        colX = { ...colX, ...newX };
                        const hdr = COLS.filter(c => c !== 'SI' && c !== 'Nature')
                            .map(c => `[${c}: ${c}]`).join(' | ');
                        out.push(`[SI: SI.] | [Nature of Power: Nature of Power] | ${hdr}`);
                        continue;
                    }
                    if (row.items.length < 2) {
                        const txt = row.items.map(it => it.text).join(' ').trim();
                        if (txt) out.push(txt);
                        continue;
                    }
                    const buckets = {};
                    COLS.forEach(c => buckets[c] = []);
                    for (const it of row.items) {
                        let best = COLS[0], bestDist = Infinity;
                        for (const c of COLS) {
                            const dist = Math.abs(it.x - colX[c]);
                            if (dist < bestDist) { bestDist = dist; best = c; }
                        }
                        buckets[best].push(it);
                    }
                    const parts = COLS.map(c => {
                        const val = fmtBucket(buckets[c]);
                        if (!val) return null;
                        if (c === 'SI') return `[SI: ${val}]`;
                        if (c === 'Nature') return `[Nature of Power: ${val}]`;
                        return `[${c}: ${val}]`;
                    }).filter(Boolean);
                    if (parts.length > 0) out.push(parts.join(' | '));
                }
                const pageText = out.join('\n');
                pagesText.push(pageText);
                return pageText;
            });
    }
    await pdf(buffer, { pagerender: render_page });
    return pagesText;
}

// =============================================================================
// EXPRESS APP FOR THE /ask ENDPOINT
// =============================================================================
const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

app.post('/ask', async (req, res) => {
    const { question } = req.body;
    if (!question || question.trim() === "") {
        return res.status(400).json({ error: "Question cannot be empty." });
    }

    const isHindiQuery = /[\u0900-\u097F]/.test(question) ||
        /\b(kaun|kya|kab|kaise|kis|kiske|kiski|kiska|hai|hain|ko|se|mein|par|ke|ki|ka|liye|tha|thi|raha|rahe|rahi|hoga|hoge|hogi|batao|bataiye|samjhaye|samjhao|chahiye|kar|sakte|sakta|sakti)\b/i.test(question);

    const optionsEnglish = `\n\nHere are some options you can explore:
<button class="chat-opt-btn" onclick="selectSuggestion('Who is approving authority under DOP clause 4.3 for Rs 2600000')">📊 Who is approving authority under DOP clause 4.3 for Rs 26 lakh?</button>
<button class="chat-opt-btn" onclick="selectSuggestion('who is approving authority under clause 4.1 for Rs 21 lakh')">💼 Who is approving authority under clause 4.1 for Rs 21 lakh?</button>
<button class="chat-opt-btn" onclick="selectSuggestion('what does clause 4.3 cover?')">📖 What does clause 4.3 cover?</button>
<button class="chat-opt-btn" onclick="selectSuggestion('what does ED stand for?')">🔍 What does ED stand for?</button>`;

    const optionsHindi = `\n\nयहाँ कुछ विकल्प दिए गए हैं जिन्हें आप देख सकते हैं:
<button class="chat-opt-btn" onclick="selectSuggestion('DOP क्लॉज 4.3 के तहत 26 lakh रुपये के लिए मंजूरी देने वाला प्राधिकारी कौन है')">📊 DOP क्लॉज 4.3 के तहत 26 लाख रुपये के लिए मंजूरी देने वाला प्राधिकारी कौन है?</button>
<button class="chat-opt-btn" onclick="selectSuggestion('क्लॉज 4.1 के तहत 21 lakh रुपये के लिए मंजूरी देने वाला प्राधिकारी कौन है')">💼 क्लॉज 4.1 के तहत 21 लाख रुपये के लिए मंजूरी देने वाला प्राधिकारी कौन है?</button>
<button class="chat-opt-btn" onclick="selectSuggestion('क्लॉज 4.3 में क्या शामिल है')">📖 क्लॉज 4.3 में क्या शामिल है?</button>
<button class="chat-opt-btn" onclick="selectSuggestion('ED का क्या अर्थ है')">🔍 ED का क्या अर्थ है?</button>`;

    // Handle greetings
    const lowerQ = question.trim().toLowerCase().replace(/[?,.]/g, '');
    const isGreeting = /^(hi|hello|hey|good\s+morning|good\s+afternoon|good\s+evening|greetings|yo|help|sup|नमस्ते|नमस्कार|हेलो|प्रणाम)(\s+.*)?$/i.test(lowerQ);
    if (isGreeting) {
        try {
            const completion = await getOpenAI().chat.completions.create({
                model: 'gpt-4o',
                messages: [
                    {
                        role: 'system',
                        content: `You are a warm, friendly AI assistant for company policy documents.
Your goal is to greet the user and offer options to help them get started.
The uploaded document is 'DOP Sec II Revised march 2023.pdf', which covers Delegation of Powers (DOP) for purchases, contracts, stores & spares, etc.
Respond in natural, friendly, conversational language. End your greeting by asking what they would like to search.
Write your greeting in separate, clear paragraphs (separated by double newlines '\\n\\n') when appropriate. Use markdown **bolding** to highlight important terms.
${isHindiQuery ? "Since the user is asking/interacting in Hindi/Hinglish, write your entire response in Hindi (using Devanagari script). Make it warm, friendly, and natural." : ""}
Format your response strictly as JSON: {"answer": "...", "clause": "Greeting"}`
                    },
                    { role: 'user', content: question }
                ],
                response_format: { type: 'json_object' },
                temperature: 0.7
            });
            const responseData = JSON.parse(completion.choices[0].message.content);
            const answerText = responseData.answer + (isHindiQuery ? optionsHindi : optionsEnglish);
            return res.json({ answer: formatAnswer(answerText), sourcePdf: "-", pageNumber: "-", confidence: "100%", clause: "Greeting" });
        } catch (err) {
            console.error("GPT greeting error:", err);
            const fallback = isHindiQuery
                ? `नमस्ते! मैं आपका **दस्तावेज़ एआई सहायक** हूँ। आज मैं आपकी क्या सहायता कर सकता हूँ?`
                : `Hello! I am your **Document AI Assistant**. How can I help you today?`;
            return res.json({ answer: formatAnswer(fallback + (isHindiQuery ? optionsHindi : optionsEnglish)), sourcePdf: "-", pageNumber: "-", confidence: "100%", clause: "Greeting" });
        }
    }

    try {
        console.log(`Searching answers for query: "${question}"...`);
        const normalizedQuestion = question.toLowerCase()
            .replace(/(?:रुपये|रुपए|रुपया|रु\.?|रू\.?)/g, 'rs')
            .replace(/(?:लाख|ल\b)/g, 'lakh')
            .replace(/(?:करोड़|करोड|सीआर\b)/g, 'crore')
            .replace(/(?:क्लॉज|क्लाज|धारा)/g, 'clause');

        const queryEmbeddingResponse = await getOpenAI().embeddings.create({
            model: "text-embedding-3-small",
            input: question
        });
        const queryEmbedding = queryEmbeddingResponse.data[0].embedding;

        const clauseRegex = /(\b\d+\.\d+\b)|(?:\b(?:clause|cl|section|si|item|s\.no|no\.?|number)\s+(\d+)(?!\.\d)\b)/gi;
        let clauseMatches = [], match;
        while ((match = clauseRegex.exec(normalizedQuestion)) !== null) {
            if (match[1]) clauseMatches.push(match[1]);
            else if (match[2]) clauseMatches.push(match[2]);
        }
        console.log(`Extracted clause numbers from query:`, clauseMatches);

        // 1. Direct metadata query for exact clauses (guarantees they are fetched)
        let directChunks = [];
        if (clauseMatches.length > 0) {
            try {
                const directQuery = db.collection("chunks").where("clauses", "array-contains-any", clauseMatches);
                const directSnap = await directQuery.get();
                directSnap.forEach(doc => {
                    directChunks.push({ id: doc.id, ...doc.data() });
                });
                console.log(`Direct metadata query found ${directChunks.length} chunks matching:`, clauseMatches);
            } catch (err) {
                console.error("Direct clause query error:", err);
            }
        }

        // 2. Vector search query
        const query = db.collection("chunks").findNearest({
            vectorField: 'embedding',
            queryVector: queryEmbedding,
            limit: 150,
            distanceMeasure: 'COSINE'
        });

        const chunksSnap = await query.get();
        if (chunksSnap.empty && directChunks.length === 0) {
            return res.json({
                answer: formatAnswer(isHindiQuery
                    ? "अभी तक कोई दस्तावेज़ अपलोड या अनुक्रमित नहीं किया गया है। कृपया एडमिन पैनल पर जाएं और पीडीएफ अपलोड करें।"
                    : "No documents have been uploaded or indexed yet. Please go to the admin panel and upload PDFs."),
                sourcePdf: "-", pageNumber: "-", confidence: "-", clause: "-"
            });
        }

        // 3. Merge vector and direct search results, removing duplicates
        const mergedChunksMap = new Map();
        directChunks.forEach(c => {
            mergedChunksMap.set(c.id, c);
        });
        chunksSnap.forEach(doc => {
            if (!mergedChunksMap.has(doc.id)) {
                mergedChunksMap.set(doc.id, { id: doc.id, ...doc.data() });
            }
        });

        // 4. Calculate similarity and apply boosting for exact matches
        let allChunks = [];
        mergedChunksMap.forEach((chunkData) => {
            const vec = chunkData.embedding ? chunkData.embedding.toArray() : [];
            const similarity = vec.length > 0 ? cosineSimilarity(queryEmbedding, vec) : 0;
            let isExactClauseMatch = false;

            for (const clauseNum of clauseMatches) {
                // Boost if the chunk metadata explicitly lists the clause or matches text regex
                if (chunkData.clauses && chunkData.clauses.includes(clauseNum)) {
                    isExactClauseMatch = true;
                    break;
                }
                if (chunkData.text) {
                    const siRegex = new RegExp(`\\[SI:\\s*${clauseNum.replace('.', '\\.')}[\\s\\].(]`, 'i');
                    const wordRegex = new RegExp(`\\b${clauseNum.replace('.', '\\.')}\\.\\b`, 'i');
                    if (siRegex.test(chunkData.text) || wordRegex.test(chunkData.text)) {
                        isExactClauseMatch = true;
                        break;
                    }
                }
            }
            const boostedSimilarity = isExactClauseMatch ? similarity + 0.35 : similarity;
            allChunks.push({ ...chunkData, rawSimilarity: similarity, boostedSimilarity, isExactClauseMatch });
        });

        allChunks.sort((a, b) => b.boostedSimilarity - a.boostedSimilarity);
        let topChunks = allChunks.slice(0, 15);

        const topDoc = topChunks[0];
        const highestSimilarity = topDoc.boostedSimilarity || topDoc.rawSimilarity || 0.99;
        let confidencePercentage = topDoc.isExactClauseMatch ? 100 : scaleConfidence(highestSimilarity);
        console.log(`Top chunk: raw=${topDoc.rawSimilarity?.toFixed(4)}, boosted=${topDoc.boostedSimilarity?.toFixed(4)}, exactClauseMatch=${topDoc.isExactClauseMatch} -> confidence: ${confidencePercentage}%`);

        // Lower threshold from 0.25 to 0.20 to be more permissive with general questions
        if (highestSimilarity < 0.20) {
            try {
                const completion = await getOpenAI().chat.completions.create({
                    model: 'gpt-4o',
                    messages: [
                        {
                            role: 'system',
                            content: `You are a helpful, conversational AI Assistant for company policy documents.
The user is asking something that could not be matched with high confidence to the uploaded manuals.
Reply naturally and politely. If off-topic, guide them back to the policy documents.
Structure your response in multiple short paragraphs. Use markdown **bolding** to highlight key terms.
${isHindiQuery ? "Write your entire response in Hindi (using Devanagari script)." : ""}
Format strictly as JSON: {"answer": "...", "clause": "-"}`
                        },
                        { role: 'user', content: question }
                    ],
                    response_format: { type: 'json_object' },
                    temperature: 0.7
                });
                const responseData = JSON.parse(completion.choices[0].message.content);
                const answerText = responseData.answer + (isHindiQuery ? optionsHindi : optionsEnglish);
                return res.json({ answer: formatAnswer(answerText), sourcePdf: "-", pageNumber: "-", confidence: "Low", clause: "-" });
            } catch (err) {
                return res.json({
                    answer: formatAnswer((isHindiQuery ? "मुझे अपलोड किए गए मैनुअल में उत्तर नहीं मिला।" : "I couldn't find relevant sections in the uploaded manuals.") + (isHindiQuery ? optionsHindi : optionsEnglish)),
                    sourcePdf: "-", pageNumber: "-", confidence: "Low", clause: "-"
                });
            }
        }

        // Deterministic authority resolution
        let preComputedFact = null;
        const targetLakh = extractTargetAmountLakh(question);
        if (clauseMatches.length > 0 && targetLakh !== null) {
            const clauseNum = clauseMatches[0];
            const clauseRow = extractClauseRow(topChunks, clauseNum);
            if (clauseRow) {
                const authority = resolveAuthority(clauseRow, targetLakh);
                const limitTable = AUTHORITY_ORDER.filter(k => clauseRow[k])
                    .map(k => `${AUTHORITY_NAMES[k]}: ${clauseRow[k]}`).join(' | ');
                preComputedFact = { clauseNum, targetLakh, authority, clauseRow, limitTable };
                console.log(`[RESOLVE] Clause ${clauseNum}, target=${targetLakh}L → ${authority.name} (${authority.limitText})`);
            }
        }

        let contextText = '';
        topChunks.forEach((chunk, index) => {
            contextText += `\n--- Context block ${index + 1} (Source: ${chunk.docName}, Page: ${chunk.pageNumber}) ---\n${chunk.text}\n`;
        });

        let systemPrompt, userPrompt;
        if (preComputedFact) {
            const { clauseNum, targetLakh: tl, authority, clauseRow, limitTable } = preComputedFact;
            const targetDisplay = tl >= 100 ? `Rs. ${(tl / 100).toFixed(tl % 100 === 0 ? 0 : 2)} crore` : `Rs. ${tl} lakh`;
            const lowerLevels = AUTHORITY_ORDER.slice(0, AUTHORITY_ORDER.indexOf(authority.key));
            const lowerReasons = lowerLevels.filter(k => clauseRow[k] && parseLimitToLakh(clauseRow[k]) < tl)
                .map(k => `${AUTHORITY_NAMES[k]} (limit: ${clauseRow[k]})`).join(', ');
            systemPrompt = `You are a helpful, conversational document assistant. Write a warm, friendly, and clear answer in natural user-friendly language using ONLY the facts provided. Do NOT alter any name, limit, or amount. Respond with JSON: {"answer": "...", "clause": "Clause ${clauseNum}"}`;
            userPrompt = `VERIFIED FACTS:
- Clause: ${clauseNum} — ${clauseRow.Nature || 'Delegation of Powers'}
- Query amount: ${targetDisplay}
- Delegation limits for Clause ${clauseNum}: ${limitTable}
- COMPETENT AUTHORITY: ${authority.name}
- Their limit: ${authority.limitText}
${lowerReasons ? `- Cannot approve: ${lowerReasons}` : ''}

Instructions:
1. Explain this in natural, friendly style. Use **bolding** for key terms. Write in multiple short paragraphs (double newlines).
${isHindiQuery ? "Write the entire response in Hindi (Devanagari script), keeping exact names/limits/clause numbers bolded." : ""}
2. End with a friendly follow-up question.
3. Do not alter any numbers or authority names.
Answer JSON:`;
        } else {
            systemPrompt = `You are an expert AI assistant for company policy documents.
CRITICAL INSTRUCTIONS:
1. Answer using ONLY facts from the provided context blocks.
2. If the context doesn't contain the answer, say "I couldn't find the answer in the provided documents."
3. Do NOT alter clause numbers, amounts, names, or quotes.
4. ED = Executive Director, GM = General Manager, AGM = Additional General Manager, DGM = Deputy General Manager, SM = Senior Manager.
5. Respond with JSON: {"answer": "...", "clause": "..."}.
6. Structure your response in multiple short, distinct paragraphs (double newlines). Use **bolding** for key terms.
7. End with a friendly follow-up question.
${isHindiQuery ? "Write your entire response in Hindi (Devanagari script)." : ""}`;
            userPrompt = `Context:\n${contextText}\n\nQuestion: ${question}\n\nAnswer JSON:`;
        }

        const completion = await getOpenAI().chat.completions.create({
            model: 'gpt-4o',
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt }
            ],
            response_format: { type: 'json_object' },
            temperature: 0
        });

        let answer = "", clause = "General";
        try {
            const responseData = JSON.parse(completion.choices[0].message.content);
            answer = responseData.answer;
            clause = responseData.clause || "General";
        } catch (jsonErr) {
            answer = completion.choices[0].message.content;
        }

        const notFoundPatterns = ["couldn't find", "could not find", "cannot find", "not found", "no information",
            "insufficient information", "does not state", "not mention",
            "नहीं मिला", "जानकारी नहीं है", "प्रासंगिक जानकारी नहीं", "उत्तर नहीं मिल"];
        const isNotFound = notFoundPatterns.some(pat => answer.toLowerCase().includes(pat));

        let buttonsHtml = "";
        if (isNotFound) {
            confidencePercentage = 0;
            clause = "-";
            if (isHindiQuery) {
                buttonsHtml = `\n\nयहाँ कुछ विकल्प दिए गए हैं जिन्हें आप देख सकते हैं:
<button class="chat-opt-btn" onclick="selectSuggestion('DOP क्लॉज 4.3 के तहत 26 lakh रुपये के लिए मंजूरी देने वाला प्राधिकारी कौन है')">📊 DOP क्लॉज 4.3 के तहत 26 लाख रुपये के लिए मंजूरी देने वाला प्राधिकारी कौन है?</button>
<button class="chat-opt-btn" onclick="selectSuggestion('क्लॉज 4.1 के तहत 21 lakh रुपये के लिए मंजूरी देने वाला प्राधिकारी कौन है')">💼 क्लॉज 4.1 के तहत 21 लाख रुपये के लिए मंजूरी देने वाला प्राधिकारी कौन है?</button>
<button class="chat-opt-btn" onclick="selectSuggestion('क्लॉज 4.3 में क्या शामिल है')">📖 क्लॉज 4.3 में क्या शामिल है?</button>
<button class="chat-opt-btn" onclick="selectSuggestion('ED का क्या अर्थ है')">🔍 ED का क्या अर्थ है?</button>`;
                answer = `मैं प्रदान किए गए दस्तावेजों में उत्तर नहीं ढूंढ सका।` + buttonsHtml;
            } else {
                answer = `I couldn't find the answer in the provided documents.` + optionsEnglish;
            }
        } else if (preComputedFact) {
            const { clauseNum, targetLakh: tl } = preComputedFact;
            let nextAmount = tl === 26 ? 21 : 26;
            let otherClause = clauseNum === "4.3" ? "4.1" : "4.3";
            if (isHindiQuery) {
                buttonsHtml = `\n\n<button class="chat-opt-btn" onclick="selectSuggestion('DOP क्लॉज ${clauseNum} के तहत रुपये ${nextAmount} लाख की जांच करें')">🔍 क्लॉज ${clauseNum} के तहत रुपये ${nextAmount} लाख की जांच करें</button>
<button class="chat-opt-btn" onclick="selectSuggestion('रुपये 21 लाख के लिए क्लॉज ${otherClause} की जांच करें')">💼 रुपये 21 लाख के लिए क्लॉज ${otherClause} की जांच करें</button>
<button class="chat-opt-btn" onclick="selectSuggestion('क्लॉज ${clauseNum} में क्या शामिल है')">📖 क्लॉज ${clauseNum} में क्या शामिल है?</button>`;
            } else {
                buttonsHtml = `\n\n<button class="chat-opt-btn" onclick="selectSuggestion('who is approving authority under clause ${clauseNum} for Rs ${nextAmount} lakh')">🔍 Check Rs ${nextAmount} lakh under Clause ${clauseNum}</button>
<button class="chat-opt-btn" onclick="selectSuggestion('who is approving authority under clause ${otherClause} for Rs 21 lakh')">💼 Check Clause ${otherClause} for Rs 21 lakh</button>
<button class="chat-opt-btn" onclick="selectSuggestion('what does clause ${clauseNum} cover?')">📖 What does Clause ${clauseNum} cover?</button>`;
            }
            answer = answer + buttonsHtml;
        } else {
            let detectedClause = clauseMatches[0] || (clause !== "General" && clause.length < 15 ? clause.replace("Clause ", "") : null);
            if (detectedClause) {
                let otherClause = detectedClause.includes("4.3") ? "4.1" : "4.3";
                if (isHindiQuery) {
                    buttonsHtml = `\n\n<button class="chat-opt-btn" onclick="selectSuggestion('DOP क्लॉज ${detectedClause} के तहत 26 lakh रुपये के लिए मंजूरी देने वाला प्राधिकारी कौन है')">📊 DOP क्लॉज ${detectedClause} के तहत 26 लाख रुपये के लिए मंजूरी देने वाला प्राधिकारी कौन है?</button>
<button class="chat-opt-btn" onclick="selectSuggestion('DOP क्लॉज ${detectedClause} के तहत 21 lakh रुपये के लिए मंजूरी देने वाला प्राधिकारी कौन है')">💼 DOP क्लॉज ${detectedClause} के तहत 21 लाख रुपये के लिए मंजूरी देने वाला प्राधिकारी कौन है?</button>
<button class="chat-opt-btn" onclick="selectSuggestion('क्लॉज ${otherClause} में क्या शामिल है')">📖 क्लॉज ${otherClause} में क्या शामिल है?</button>`;
                } else {
                    buttonsHtml = `\n\n<button class="chat-opt-btn" onclick="selectSuggestion('Who is approving authority under DOP clause ${detectedClause} for Rs 2600000')">📊 Who is approving authority under Clause ${detectedClause} for Rs 26 lakh?</button>
<button class="chat-opt-btn" onclick="selectSuggestion('who is approving authority under clause ${detectedClause} for Rs 2100000')">💼 Who is approving authority under Clause ${detectedClause} for Rs 21 lakh?</button>
<button class="chat-opt-btn" onclick="selectSuggestion('what does clause ${otherClause} cover?')">📖 What does Clause ${otherClause} cover?</button>`;
                }
            } else {
                buttonsHtml = isHindiQuery ? optionsHindi : optionsEnglish;
            }
            answer = answer + buttonsHtml;
        }

        const primarySource = topChunks[0];
        return res.json({
            answer: formatAnswer(answer),
            sourcePdf: isNotFound ? "-" : primarySource.docName,
            pageNumber: isNotFound ? "-" : primarySource.pageNumber.toString(),
            confidence: isNotFound ? "Low" : `${confidencePercentage}%`,
            clause: clause
        });

    } catch (err) {
        console.error("QA search endpoint error:", err);
        const errorFallback = isHindiQuery
            ? `मुझे इस समय डेटाबेस से कनेक्ट करने में समस्या हो रही है। कृपया एक क्षण में पुन: प्रयास करें।`
            : `I'm having trouble connecting to the document database right now. Please try again in a moment.`;
        return res.json({ answer: formatAnswer(errorFallback + (isHindiQuery ? optionsHindi : optionsEnglish)), sourcePdf: "-", pageNumber: "-", confidence: "Low", clause: "-" });
    }
});

// =============================================================================
// CLOUD FUNCTION: HTTP endpoint (wraps the Express app)
// Permanent URL: https://asia-south1-robotic-af198.cloudfunctions.net/api
// =============================================================================
exports.api = functions
    .region('asia-south1')
    .runWith(runtimeOpts)
    .https.onRequest(app);

// =============================================================================
// CLOUD FUNCTION: Auto-index PDFs when uploaded
// =============================================================================
exports.indexDocument = functions
    .region('asia-south1')
    .runWith(runtimeOpts)
    .firestore.document('documents/{docId}')
    .onWrite(async (change, context) => {
        const after = change.after;
        if (!after || !after.exists) return null;

        const docData = after.data();
        const docId = context.params.docId;

    // Only process when status is "Processing"
    if (docData.status !== "Processing") return null;

    const docRef = db.collection("documents").doc(docId);
    console.log(`Cloud Function: Processing document "${docData.name}" (${docId})...`);

    try {
        const storagePath = `documents/${docId}/${docData.name}`;
        const fileRef = bucket.file(storagePath);
        const [exists] = await fileRef.exists();
        if (!exists) throw new Error(`File not found in storage at path: ${storagePath}`);

        const [fileBuffer] = await fileRef.download();
        console.log(`Downloaded file size: ${fileBuffer.length} bytes.`);

        const pagesText = await parsePdfPages(fileBuffer);
        console.log(`Parsed ${pagesText.length} pages from "${docData.name}".`);
        await docRef.update({ pages: pagesText.length });

        // Delete old chunks if re-indexing
        const oldChunksSnap = await db.collection("chunks").where("docId", "==", docId).get();
        if (!oldChunksSnap.empty) {
            const batch = db.batch();
            oldChunksSnap.forEach(chunkDoc => batch.delete(chunkDoc.ref));
            await batch.commit();
        }

        // Generate embeddings and save chunks
        let currentHeaders = "SI. Nature of Power | ED | G.M. | AGM | DGM | S.M.";
        for (let i = 0; i < pagesText.length; i++) {
            const pageText = pagesText[i].trim();
            const pageNumber = i + 1;
            if (pageText.length < 10) { console.log(`Skipping empty page ${pageNumber}.`); continue; }

            const lines = pageText.split('\n');
            for (const line of lines) {
                const cleanLine = line.trim();
                if (cleanLine.includes('ED') && cleanLine.includes('G.M.') && cleanLine.includes('AGM') && cleanLine.includes('DGM')) {
                    currentHeaders = cleanLine.replace(/\s+/g, ' ');
                }
            }

            // Line-aware chunking to ensure rows/lines are not cut in half
            let chunks = [];
            let currentChunkLines = [];
            let currentLength = 0;
            const maxChunkLength = 1500;
            const overlapLines = 2; // Overlap of 2 lines for continuity

            for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
                const line = lines[lineIdx];
                currentChunkLines.push(line);
                currentLength += line.length + 1; // +1 for newline

                if (currentLength >= maxChunkLength || lineIdx === lines.length - 1) {
                    chunks.push(currentChunkLines.join('\n'));
                    // Keep the last few lines for overlap
                    const startIndex = Math.max(0, currentChunkLines.length - overlapLines);
                    currentChunkLines = currentChunkLines.slice(startIndex);
                    currentLength = currentChunkLines.reduce((acc, l) => acc + l.length + 1, 0);
                }
            }

            for (let j = 0; j < chunks.length; j++) {
                const chunkText = chunks[j];
                const prefixedText = `[Context - Document: ${docData.name} | Page: ${pageNumber} | Table Columns: ${currentHeaders}]\n${chunkText}`;
                
                // Extract clause numbers contained in this chunk for high-accuracy direct retrieval
                const clauseSet = new Set();
                const siRegex = /\[SI:\s*([^\]]+)\]/gi;
                let siMatch;
                siRegex.lastIndex = 0;
                while ((siMatch = siRegex.exec(chunkText)) !== null) {
                    const val = siMatch[1].trim();
                    const numMatch = val.match(/^(\d+(?:\.\d+)?)/);
                    if (numMatch) {
                        clauseSet.add(numMatch[1]);
                    } else if (val.length < 15) {
                        clauseSet.add(val.toLowerCase());
                    }
                }
                const clauses = Array.from(clauseSet);

                const embeddingResponse = await getOpenAI().embeddings.create({
                    model: "text-embedding-3-small",
                    input: prefixedText
                });
                const embedding = embeddingResponse.data[0].embedding;
                await db.collection("chunks").add({
                    docId,
                    docName: docData.name,
                    pageNumber,
                    text: prefixedText,
                    clauses: clauses,
                    embedding: FieldValue.vector(embedding),
                    uploadDate: new Date()
                });
            }
        }

        await docRef.update({ status: "Indexed" });
        console.log(`Successfully indexed "${docData.name}".`);

    } catch (err) {
        console.error(`Error processing "${docData.name}":`, err);
        await docRef.update({ status: "Error" });
    }

    return null;
});

// =============================================================================
// CLOUD FUNCTION: Auto-delete chunks when a document is deleted
// =============================================================================
exports.cleanupChunks = functions
    .region('asia-south1')
    .runWith({ timeoutSeconds: 60, memory: '256MB' })
    .firestore.document('documents/{docId}')
    .onDelete(async (snap, context) => {
        const docId = context.params.docId;
        const docData = snap.data();
    console.log(`Cleaning up chunks for deleted document "${docData.name}" (${docId})...`);

    try {
        const chunksSnap = await db.collection("chunks").where("docId", "==", docId).get();
        if (!chunksSnap.empty) {
            const batch = db.batch();
            chunksSnap.forEach(chunkDoc => batch.delete(chunkDoc.ref));
            await batch.commit();
            console.log(`Deleted ${chunksSnap.size} chunks for "${docData.name}".`);
        }
    } catch (err) {
        console.error(`Failed to delete chunks for "${docData.name}":`, err);
    }

    return null;
});
