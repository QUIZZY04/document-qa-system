require('dotenv').config();
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const { FieldValue } = require('firebase-admin/firestore');
const { OpenAI } = require('openai');
const pdf = require('pdf-parse');
const fs = require('fs');
const path = require('path');

// Initialize Express App
const app = express();
app.use(cors());
app.use(express.json());

// Initialize OpenAI client
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

// Initialize Firebase Admin SDK
const serviceAccountPath = path.join(__dirname, 'service-account.json');
if (!fs.existsSync(serviceAccountPath)) {
    console.error("CRITICAL ERROR: 'service-account.json' not found in the root directory!");
    console.error("Please follow the instructions to download your service account key and place it here.");
    process.exit(1);
}

const serviceAccount = require(serviceAccountPath);
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    storageBucket: "robotic-af198.firebasestorage.app" // Match your storage bucket config
});

const db = admin.firestore();
const bucket = admin.storage().bucket();

// Helper to calculate cosine similarity
function cosineSimilarity(vecA, vecB) {
    let dotProduct = 0.0;
    let normA = 0.0;
    let normB = 0.0;
    for (let i = 0; i < vecA.length; i++) {
        dotProduct += vecA[i] * vecB[i];
        normA += vecA[i] * vecA[i];
        normB += vecB[i] * vecB[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

// Map cosine similarity scores of OpenAI embeddings to an intuitive confidence percentage
// Uses boosted similarity so clause-matched chunks properly reflect 100% confidence
function scaleConfidence(similarity) {
    if (similarity <= 0.2) return Math.round(similarity * 100);
    if (similarity <= 0.3) return Math.round(20 + (similarity - 0.2) * 300); // 20% to 50%
    if (similarity <= 0.5) return Math.round(50 + (similarity - 0.3) * 150); // 50% to 80%
    if (similarity <= 0.7) return Math.round(80 + (similarity - 0.5) * 100); // 80% to 100%
    return 100; // anything >= 0.70 boosted similarity = 100%
}


// =============================================================================
// DETERMINISTIC AUTHORITY RESOLVER
// All numerical threshold comparisons happen here in JavaScript — never by LLM.
// =============================================================================

function parseLimitToLakh(raw) {
    if (!raw) return 0;
    let s = raw.toString().toUpperCase()
        .replace(/RS\.?\s*/g, '').replace(/UPTO\s*/g, '').replace(/,/g, '')
        .replace(/[.]+$/, '')   // strip trailing period(s)
        .trim();
    if (!s || s === '-' || s === 'NIL') return 0;
    if (s.includes('FULL') || s.includes('POWER')) return Infinity;
    // OCR corrections: letter O → 0, letter S before O or digit → 5
    s = s.replace(/\bSO\b/g, '50')   // "SO" → "50" (most common: Rs.SO lakh)
         .replace(/\bS(\d)/g, '5$1') // "S<digit>" → "5<digit>"
         .replace(/(\d)[O]/gi, '$10') // digit-O → digit-0
         .replace(/[O](\d)/gi, '0$1') // O-digit → 0-digit
         .replace(/[O]\b/g, '0');     // trailing O → 0
    // Normalise unit words
    s = s.replace(/LAKHSH?|1AKH|LAKH/gi, 'LAKH').replace(/CRORE|CR\b/gi, 'CRORE')
         .replace(/\s+/g, ' ').trim();
    let m;
    m = s.match(/^([\d.]+)\s*CRORE$/i); if (m) return parseFloat(m[1]) * 100;
    m = s.match(/^([\d.]+)\s*LAKH$/i);  if (m) return parseFloat(m[1]);
    m = s.match(/^([\d.]+)$/);           if (m) return parseFloat(m[1]);
    return 0;
}

function extractTargetAmountLakh(question) {
    const q = question.replace(/,/g, '').toLowerCase();
    
    const unitRegex = /(\d+(?:\.\d+)?)\s*(crore|cr|lakh|l)\b/gi;
    let match;
    unitRegex.lastIndex = 0;
    if ((match = unitRegex.exec(q)) !== null) {
        const val = parseFloat(match[1]);
        const unit = match[2].toLowerCase();
        if (unit.startsWith('c')) {
            return val * 100;
        } else if (unit.startsWith('l')) {
            return val;
        }
    }
    
    const rsRegex = /rs\.?\s*(\d+(?:\.\d+)?)\b/gi;
    rsRegex.lastIndex = 0;
    if ((match = rsRegex.exec(q)) !== null) {
        const val = parseFloat(match[1]);
        if (val >= 10000) {
            return val / 100000;
        }
        return val;
    }
    
    let temp = q;
    const clauseRegex = /\b\d+\.\d+\b/g;
    temp = temp.replace(clauseRegex, '');
    
    const anyNumRegex = /\b(\d+(?:\.\d+)?)\b/g;
    if ((match = anyNumRegex.exec(temp)) !== null) {
        const val = parseFloat(match[1]);
        if (val >= 10000) {
            return val / 100000;
        }
        return val;
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

// Custom page-by-page PDF parser with DYNAMIC column detection per page.
// For each page it finds the header row (contains ED+GM+AGM), reads the
// X-coordinate of every authority column, then assigns each data cell to
// the nearest column — fixes wrong mappings across all DOP pages.
async function parsePdfPages(buffer) {
    let pagesText = [];

    // Normalize a header-cell text to a canonical column key
    function toColKey(text) {
        const t = text.toUpperCase().replace(/[\s.]/g, '');
        if (t === 'ED')  return 'ED';
        if (t === 'GM')  return 'GM';
        if (t === 'AGM') return 'AGM';
        if (t === 'DGM') return 'DGM';
        if (t === 'SM')  return 'SM';
        return null;
    }

    // A row is a header row when it contains all of ED, GM, AGM
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

                // ── 1. Group items into Y-lines (tolerance = 3 pt) ──────────────
                const yTol = 3;
                let lines = [];
                for (const item of items) {
                    const x = item.transform[4], y = item.transform[5];
                    const text = item.str;
                    const fl = lines.find(l => Math.abs(l.y - y) <= yTol);
                    if (fl) fl.items.push({ text, x, y });
                    else    lines.push({ y, items: [{ text, x, y }] });
                }
                lines.sort((a, b) => b.y - a.y); // top → bottom

                // ── 2. Merge Y-lines into logical table rows ─────────────────────
                // A new row starts when a cell appears in the leftmost column (X < 100)
                let rows = [];
                let curRow = null;
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

                // ── 3. Dynamic column positions ──────────────────────────────────
                // Start with sensible defaults (Page 7/8 layout).
                // They get replaced the moment a header row is detected.
                let colX = { SI: 50, Nature: 180, ED: 275, GM: 322, AGM: 370, DGM: 425, SM: 480 };

                const fmtBucket = (bucket) => {
                    bucket.sort((a, b) => Math.abs(a.y - b.y) > 2 ? b.y - a.y : a.x - b.x);
                    return bucket.map(it => it.text).join(' ').replace(/\s+/g, ' ').trim();
                };

                let out = [];

                for (const row of rows) {
                    const sorted = [...row.items].sort((a, b) => a.x - b.x);

                    // ── Detect header row → update column X positions ────────────
                    if (isHeaderRow(sorted)) {
                        const newX = {};
                        for (const it of sorted) {
                            const k = toColKey(it.text);
                            if (k && newX[k] === undefined) newX[k] = it.x;
                        }
                        colX = { ...colX, ...newX };
                        const hdr = COLS
                            .filter(c => c !== 'SI' && c !== 'Nature')
                            .map(c => `[${c}: ${c}]`).join(' | ');
                        out.push(`[SI: SI.] | [Nature of Power: Nature of Power] | ${hdr}`);
                        continue;
                    }

                    if (row.items.length < 2) {
                        const txt = row.items.map(it => it.text).join(' ').trim();
                        if (txt) out.push(txt);
                        continue;
                    }

                    // ── Assign each item to the nearest known column ─────────────
                    const sortedCols = COLS
                        .filter(c => colX[c] !== undefined)
                        .map(c => ({ key: c, x: colX[c] }))
                        .sort((a, b) => a.x - b.x);

                    const buckets = {};
                    COLS.forEach(c => { buckets[c] = []; });

                    for (const it of row.items) {
                        let best = sortedCols[0];
                        let bestDist = Math.abs(it.x - sortedCols[0].x);
                        for (const col of sortedCols) {
                            const d = Math.abs(it.x - col.x);
                            if (d < bestDist) { bestDist = d; best = col; }
                        }
                        buckets[best.key].push(it);
                    }

                    const si     = fmtBucket(buckets['SI']);
                    const nature = fmtBucket(buckets['Nature']);
                    const ed     = fmtBucket(buckets['ED']);
                    const gm     = fmtBucket(buckets['GM']);
                    const agm    = fmtBucket(buckets['AGM']);
                    const dgm    = fmtBucket(buckets['DGM']);
                    const sm     = fmtBucket(buckets['SM']);

                    if (si || nature || ed || gm || agm || dgm || sm) {
                        const parts = [];
                        if (si)     parts.push(`[SI: ${si}]`);
                        if (nature) parts.push(`[Nature of Power: ${nature}]`);
                        if (ed)     parts.push(`[ED: ${ed}]`);
                        if (gm)     parts.push(`[GM: ${gm}]`);
                        if (agm)    parts.push(`[AGM: ${agm}]`);
                        if (dgm)    parts.push(`[DGM: ${dgm}]`);
                        if (sm)     parts.push(`[SM: ${sm}]`);
                        out.push(parts.join(' | '));
                    }
                }

                const pageText = out.join('\n');
                pagesText.push(pageText);
                return pageText;
            });
    }

    await pdf(buffer, { pagerender: render_page });
    return pagesText;
}


// Ingestion Listener: Listen to documents with "Processing" status
console.log("Starting real-time PDF Ingestion Listener...");
const processingDocs = new Set();
db.collection("documents").where("status", "==", "Processing")
    .onSnapshot((snapshot) => {
        snapshot.forEach(async (docSnap) => {
            const docId = docSnap.id;
            if (processingDocs.has(docId)) return;
            processingDocs.add(docId);
            
            const docData = docSnap.data();
            const docRef = db.collection("documents").doc(docId);
            
            console.log(`Processing document: "${docData.name}" (${docId})...`);
            
            try {
                // 1. Download file from Firebase Storage
                // Path matches: documents/{docId}/{filename}
                const storagePath = `documents/${docId}/${docData.name}`;
                const fileRef = bucket.file(storagePath);
                
                const [exists] = await fileRef.exists();
                if (!exists) {
                    console.log(`File not found at: ${storagePath}`);
                    try {
                        const [files] = await bucket.getFiles({ prefix: `documents/${docId}/` });
                        console.log(`Files under documents/${docId}/:`, files.map(f => f.name));
                        const [allFiles] = await bucket.getFiles({ maxResults: 10 });
                        console.log("First 10 files in bucket:", allFiles.map(f => f.name));
                    } catch (bucketErr) {
                        console.error("Failed to list bucket files:", bucketErr);
                    }
                    throw new Error(`File not found in storage at path: ${storagePath}`);
                }
                
                const [fileBuffer] = await fileRef.download();
                console.log(`Downloaded file size: ${fileBuffer.length} bytes.`);
                console.log(`File signature (first 10 chars): "${fileBuffer.slice(0, 10).toString()}"`);
                
                // 2. Parse PDF pages
                const pagesText = await parsePdfPages(fileBuffer);
                console.log(`Parsed ${pagesText.length} pages from "${docData.name}".`);
                
                // Update pages count in parent document
                await docRef.update({ pages: pagesText.length });
                
                // 3. Clear any existing chunks for this document to avoid duplication
                const oldChunksSnap = await db.collection("chunks").where("docId", "==", docId).get();
                if (!oldChunksSnap.empty) {
                    const batch = db.batch();
                    oldChunksSnap.forEach(chunkDoc => batch.delete(chunkDoc.ref));
                    await batch.commit();
                }
                
                // 4. Generate embeddings and save chunks with header propagation
                let currentHeaders = "SI. Nature of Power | ED | G.M. | AGM | DGM | S.M.";
                for (let i = 0; i < pagesText.length; i++) {
                    const pageText = pagesText[i].trim();
                    const pageNumber = i + 1;
                    
                    if (pageText.length < 10) {
                        console.log(`Skipping empty or tiny page ${pageNumber}.`);
                        continue;
                    }

                    // Dynamically scan for headers on this page
                    const lines = pageText.split('\n');
                    for (const line of lines) {
                        const cleanLine = line.trim();
                        if (cleanLine.includes('ED') && cleanLine.includes('G.M.') && cleanLine.includes('AGM') && cleanLine.includes('DGM')) {
                            currentHeaders = cleanLine.replace(/\s+/g, ' ');
                        } else if (cleanLine.includes('TC') && cleanLine.includes('Nomination') && cleanLine.includes('Approval')) {
                            currentHeaders = cleanLine.replace(/\s+/g, ' ');
                        }
                    }
                    
                    // Simple page segmentation: split long pages if > 1500 chars
                    const maxChunkLength = 1500;
                    let chunks = [];
                    if (pageText.length > maxChunkLength) {
                        // Split into two overlapping halves or chunks
                        let startIndex = 0;
                        while (startIndex < pageText.length) {
                            const chunkText = pageText.substring(startIndex, startIndex + maxChunkLength);
                            chunks.push(chunkText);
                            startIndex += 1000; // 500 characters overlap
                        }
                    } else {
                        chunks.push(pageText);
                    }
                    
                    for (let j = 0; j < chunks.length; j++) {
                        const chunkText = chunks[j];
                        
                        // Prepend headers context to text for embedding rich search and accurate LLM answering
                        const prefixedText = `[Context - Document: ${docData.name} | Page: ${pageNumber} | Table Columns: ${currentHeaders}]\n${chunkText}`;

                        // Call OpenAI Embeddings API with prefixed text
                        const embeddingResponse = await openai.embeddings.create({
                            model: "text-embedding-3-small",
                            input: prefixedText
                        });
                        
                        const embedding = embeddingResponse.data[0].embedding;
                        
                        // Save chunk to Firestore using FieldValue.vector for native vector search
                        await db.collection("chunks").add({
                            docId: docId,
                            docName: docData.name,
                            pageNumber: pageNumber,
                            text: prefixedText,
                            embedding: FieldValue.vector(embedding),
                            uploadDate: new Date()
                        });
                    }
                }
                
                // Update parent status to "Indexed"
                await docRef.update({ status: "Indexed" });
                console.log(`Successfully indexed "${docData.name}".`);
                
            } catch (err) {
                console.error(`Error processing "${docData.name}":`, err);
                await docRef.update({ status: "Error" });
            } finally {
                processingDocs.delete(docId);
            }
        });
    }, (error) => {
        console.error("Ingestion listener error:", error);
    });

// Search API Endpoint: /ask
app.post('/ask', async (req, res) => {
    const { question } = req.body;
    
    if (!question || question.trim() === "") {
        return res.status(400).json({ error: "Question cannot be empty." });
    }
    
    // ── 0. Handle Greetings and Short Queries Conversational style ──
    const lowerQ = question.trim().toLowerCase().replace(/[?,.]/g, '');
    const isGreeting = /^(hi|hello|hey|good\s+morning|good\s+afternoon|good\s+evening|greetings|yo|help|sup)(\s+.*)?$/i.test(lowerQ);
    if (isGreeting) {
        try {
            const completion = await openai.chat.completions.create({
                model: 'gpt-4o',
                messages: [
                    {
                        role: 'system',
                        content: `You are a warm, friendly AI assistant for company policy documents.
Your goal is to greet the user and offer options to help them get started.
The uploaded document is 'DOP Sec II Revised march 2023.pdf', which covers Delegation of Powers (DOP) for purchases, contracts, stores & spares, etc.
Respond in natural, friendly, conversational language. End your greeting by asking what they would like to search.
Format your response strictly as JSON: {"answer": "...", "clause": "Greeting"}`
                    },
                    { role: 'user', content: question }
                ],
                response_format: { type: 'json_object' },
                temperature: 0.7
            });
            const responseData = JSON.parse(completion.choices[0].message.content);
            const answerText = responseData.answer + `\n\nHere are some options you can explore:
<button class="chat-opt-btn" onclick="selectSuggestion('Who is approving authority under DOP clause 4.3 for Rs 2600000')">📊 Who is approving authority under DOP clause 4.3 for Rs 26 lakh?</button>
<button class="chat-opt-btn" onclick="selectSuggestion('who is approving authority under clause 4.1 for Rs 21 lakh')">💼 Who is approving authority under clause 4.1 for Rs 21 lakh?</button>
<button class="chat-opt-btn" onclick="selectSuggestion('what does clause 4.3 cover?')">📖 What does clause 4.3 cover?</button>
<button class="chat-opt-btn" onclick="selectSuggestion('what does ED stand for?')">🔍 What does ED stand for?</button>`;
            return res.json({
                answer: answerText,
                sourcePdf: "-",
                pageNumber: "-",
                confidence: "100%",
                clause: "Greeting"
            });
        } catch (err) {
            console.error("GPT greeting helper error:", err);
            // Fallback to static greeting
            return res.json({
                answer: `Hello! I am your Document AI Assistant. How can I help you today?

Here are some options you can explore:
<button class="chat-opt-btn" onclick="selectSuggestion('Who is approving authority under DOP clause 4.3 for Rs 2600000')">📊 Who is approving authority under DOP clause 4.3 for Rs 26 lakh?</button>
<button class="chat-opt-btn" onclick="selectSuggestion('who is approving authority under clause 4.1 for Rs 21 lakh')">💼 Who is approving authority under clause 4.1 for Rs 21 lakh?</button>
<button class="chat-opt-btn" onclick="selectSuggestion('what does clause 4.3 cover?')">📖 What does clause 4.3 cover?</button>
<button class="chat-opt-btn" onclick="selectSuggestion('what does ED stand for?')">🔍 What does ED stand for?</button>

Feel free to click any of these options or ask your own question!`,
                sourcePdf: "-",
                pageNumber: "-",
                confidence: "100%",
                clause: "Greeting"
            });
        }
    }
    
    try {
        console.log(`Searching answers for query: "${question}"...`);
        
        // 1. Generate query embedding
        const queryEmbeddingResponse = await openai.embeddings.create({
            model: "text-embedding-3-small",
            input: question
        });
        const queryEmbedding = queryEmbeddingResponse.data[0].embedding;
        
        // Extract section/clause numbers (decimals like 4.3, 4.1 or integers like 19, 15 preceded by clause indicators)
        const clauseRegex = /(\b\d+\.\d+\b)|(?:\b(?:clause|cl|section|si|item|s\.no|no\.?|number)\s+(\d+)(?!\.\d)\b)/gi;
        let clauseMatches = [];
        let match;
        while ((match = clauseRegex.exec(question)) !== null) {
            if (match[1]) {
                clauseMatches.push(match[1]); // e.g. "4.3"
            } else if (match[2]) {
                clauseMatches.push(match[2]); // e.g. "19"
            }
        }
        console.log(`Extracted clause numbers from query:`, clauseMatches);

        // 2. Perform native vector search using findNearest (expanded limit to 150 to allow reranking)
        const query = db.collection("chunks").findNearest({
            vectorField: 'embedding',
            queryVector: queryEmbedding,
            limit: 150,
            distanceMeasure: 'COSINE'
        });

        const chunksSnap = await query.get();
        if (chunksSnap.empty) {
            return res.json({
                answer: "No documents have been uploaded or indexed yet. Please go to the admin panel and upload PDFs.",
                sourcePdf: "-",
                pageNumber: "-",
                confidence: "-",
                clause: "-"
            });
        }
        
        // 3. Build all chunks with cosine similarity and keyword boosting
        let allChunks = [];
        chunksSnap.forEach((doc) => {
            const chunkData = doc.data();
            const vec = chunkData.embedding ? chunkData.embedding.toArray() : [];
            const similarity = vec.length > 0 ? cosineSimilarity(queryEmbedding, vec) : 0;
            
            // Check if chunk text contains any of the clause numbers from the query in a clause prefix format
            let isExactClauseMatch = false;
            for (const clauseNum of clauseMatches) {
                if (chunkData.text) {
                    const cleanText = chunkData.text;
                    const siRegex = new RegExp(`\\[SI:\\s*${clauseNum.replace('.', '\\.')}[\\s\\].(]`, 'i');
                    const wordRegex = new RegExp(`\\b${clauseNum.replace('.', '\\.')}\\.\\b`, 'i');
                    if (siRegex.test(cleanText) || wordRegex.test(cleanText)) {
                        isExactClauseMatch = true;
                        break;
                    }
                }
            }
            
            // Apply keyword boosting to score
            const boostedSimilarity = isExactClauseMatch ? similarity + 0.35 : similarity;
            allChunks.push({
                ...chunkData,
                rawSimilarity: similarity,
                boostedSimilarity: boostedSimilarity,
                isExactClauseMatch: isExactClauseMatch
            });
        });

        // Sort chunks by boosted similarity score descending
        allChunks.sort((a, b) => b.boostedSimilarity - a.boostedSimilarity);
        
        // Take the top 15 chunks for prompt context (provides broader coverage of tables/remarks)
        let topChunks = allChunks.slice(0, 15);

        // Compute confidence using boosted similarity (includes +0.25 clause-match bonus)
        // If the top chunk is an exact clause match (e.g. user asked about Clause 4.3 and top
        // chunk explicitly contains "4.3"), we treat confidence as 100%.
        const topDoc = topChunks[0];
        const highestSimilarity = topDoc.boostedSimilarity || topDoc.rawSimilarity || 0.99;
        let confidencePercentage;
        if (topDoc.isExactClauseMatch) {
            confidencePercentage = 100; // confirmed clause-specific answer
        } else {
            confidencePercentage = scaleConfidence(highestSimilarity);
        }
        
        console.log(`Top chunk: raw=${topDoc.rawSimilarity?.toFixed(4)}, boosted=${topDoc.boostedSimilarity?.toFixed(4)}, exactClauseMatch=${topDoc.isExactClauseMatch} -> confidence: ${confidencePercentage}%`);
        
        if (highestSimilarity < 0.25) {
            try {
                const completion = await openai.chat.completions.create({
                    model: 'gpt-4o',
                    messages: [
                        {
                            role: 'system',
                            content: `You are a helpful, conversational AI Assistant for company policy documents.
The user is either asking a general conversational query (e.g. "are you correct?", "who are you?", "thank you"), or asking something that could not be matched with high confidence to the uploaded manuals.
Your instructions:
1. If the user is asking a general question about yourself, your capabilities, your accuracy, or giving general feedback/greetings, reply naturally, politely, and conversationally (like ChatGPT). Explain how you work (grounded in the policy manuals using vector search and deterministic limit checks) but answer their immediate query directly.
2. If the user is asking an entirely off-topic query (e.g. recipes, general coding, unrelated trivia), politely explain that you are specialized in the uploaded policy manuals and cannot answer that, then guide them back.
3. Formulate a friendly follow-up asking what they'd like to check.
Format your response strictly as JSON: {"answer": "...", "clause": "-"}`
                        },
                        { role: 'user', content: question }
                    ],
                    response_format: { type: 'json_object' },
                    temperature: 0.7
                });
                const responseData = JSON.parse(completion.choices[0].message.content);
                const answerText = responseData.answer + `\n\nHere are some options you can explore:
<button class="chat-opt-btn" onclick="selectSuggestion('Who is approving authority under DOP clause 4.3 for Rs 2600000')">📊 Who is approving authority under DOP clause 4.3 for Rs 26 lakh?</button>
<button class="chat-opt-btn" onclick="selectSuggestion('who is approving authority under clause 4.1 for Rs 21 lakh')">💼 Who is approving authority under clause 4.1 for Rs 21 lakh?</button>
<button class="chat-opt-btn" onclick="selectSuggestion('what does clause 4.3 cover?')">📖 What does clause 4.3 cover?</button>
<button class="chat-opt-btn" onclick="selectSuggestion('what does ED stand for?')">🔍 What does ED stand for?</button>`;
                return res.json({
                    answer: answerText,
                    sourcePdf: "-",
                    pageNumber: "-",
                    confidence: "Low",
                    clause: "-"
                });
            } catch (err) {
                console.error("GPT low similarity helper error:", err);
                return res.json({
                    answer: `I couldn't find any relevant sections in the uploaded manuals to answer your question.

Here are some options you can explore:
<button class="chat-opt-btn" onclick="selectSuggestion('Who is approving authority under DOP clause 4.3 for Rs 2600000')">📊 Who is approving authority under DOP clause 4.3 for Rs 26 lakh?</button>
<button class="chat-opt-btn" onclick="selectSuggestion('who is approving authority under clause 4.1 for Rs 21 lakh')">💼 Who is approving authority under clause 4.1 for Rs 21 lakh?</button>
<button class="chat-opt-btn" onclick="selectSuggestion('what does clause 4.3 cover?')">📖 What does clause 4.3 cover?</button>
<button class="chat-opt-btn" onclick="selectSuggestion('what does ED stand for?')">🔍 What does ED stand for?</button>`,
                    sourcePdf: "-",
                    pageNumber: "-",
                    confidence: "Low",
                    clause: "-"
                });
            }
        }
        
        // ── 5. Deterministic authority resolution for DOP threshold queries ────
        // Extract clause + amount from question. If found, resolve authority IN CODE.
        let preComputedFact = null;
        const targetLakh = extractTargetAmountLakh(question);
        if (clauseMatches.length > 0 && targetLakh !== null) {
            const clauseNum = clauseMatches[0];
            const clauseRow = extractClauseRow(topChunks, clauseNum);
            if (clauseRow) {
                const authority = resolveAuthority(clauseRow, targetLakh);
                const limitTable = AUTHORITY_ORDER
                    .filter(k => clauseRow[k])
                    .map(k => `${AUTHORITY_NAMES[k]}: ${clauseRow[k]}`)
                    .join(' | ');
                preComputedFact = { clauseNum, targetLakh, authority, clauseRow, limitTable };
                console.log(`[RESOLVE] Clause ${clauseNum}, target=${targetLakh}L → ${authority.name} (${authority.limitText})`);
            }
        }

        // ── 6. Build context text ─────────────────────────────────────────────
        let contextText = '';
        topChunks.forEach((chunk, index) => {
            contextText += `\n--- Context block ${index + 1} (Source: ${chunk.docName}, Page: ${chunk.pageNumber}) ---\n${chunk.text}\n`;
        });

        let systemPrompt, userPrompt;

        if (preComputedFact) {
            // ── FAST PATH: authority computed deterministically, LLM only formats ──
            const { clauseNum, targetLakh: tl, authority, clauseRow, limitTable } = preComputedFact;
            const targetDisplay = tl >= 100
                ? `Rs. ${(tl / 100).toFixed(tl % 100 === 0 ? 0 : 2)} crore`
                : `Rs. ${tl} lakh`;

            // Build a clear breakdown of why lower levels cannot approve
            const lowerLevels = AUTHORITY_ORDER.slice(0, AUTHORITY_ORDER.indexOf(authority.key));
            const lowerReasons = lowerLevels
                .filter(k => clauseRow[k] && parseLimitToLakh(clauseRow[k]) < tl)
                .map(k => `${AUTHORITY_NAMES[k]} (limit: ${clauseRow[k]})`)
                .join(', ');

            systemPrompt = `You are a helpful, conversational document assistant. Write a warm, friendly, and clear answer in natural user-friendly language using ONLY the facts provided. Do NOT alter any name, limit, or amount. Respond with JSON: {"answer": "...", "clause": "Clause ${clauseNum}"}`;

            userPrompt = `VERIFIED FACTS:
- Clause: ${clauseNum} — ${clauseRow.Nature || 'Delegation of Powers'}
- Query amount: ${targetDisplay} (Rs. ${Math.round(tl * 100000).toLocaleString('en-IN')})
- Delegation limits for Clause ${clauseNum}: ${limitTable}
- COMPETENT AUTHORITY: ${authority.name}
- Their limit: ${authority.limitText}
${lowerReasons ? `- Cannot approve: ${lowerReasons}` : ''}

Instructions:
1. Explain this to the user in a natural, friendly, and conversational style (general user language).
   Example layout:
   "Under Clause ${clauseNum} for ${clauseRow.Nature || 'Delegation of Powers'}, the competent approving authority is the ${authority.name}. They can approve values ${authority.limitText}. Since your requested amount of ${targetDisplay} is within their limit, they can approve it. Lower levels like ${lowerReasons ? lowerReasons : 'none'} do not have sufficient powers for this amount."
2. ALWAYS end your response by asking the user a friendly, relevant follow-up question to engage and interact (e.g. asking if they want to check another amount, check another clause, or see definition details).
3. Do not alter any numbers or authority names in your explanation.

Answer JSON:`;

        } else {
            systemPrompt = `You are an expert AI assistant for company policy documents.
CRITICAL INSTRUCTIONS FOR 100% ACCURACY AND NO HALLUCINATIONS:
1. Grounding: Answer the question using ONLY the facts explicitly stated in the provided context blocks. Do not assume, extrapolate, or bring in outside information.
2. No Hallucinations: If the context blocks do not contain the answer, or if there is insufficient information to answer the question with absolute certainty, respond with: "I couldn't find the answer in the provided documents."
3. Exact Match: Do not alter any clause numbers, numbers, amounts, percentages, names, or quotes. They must be copied exactly from the context if mentioned in the answer.
4. Abbreviations: ED = Executive Director, GM = General Manager, AGM = Additional General Manager, DGM = Deputy General Manager, SM = Senior Manager.
5. Format: Respond with JSON format strictly: {"answer": "...", "clause": "..."}. Fill "clause" with the specific clause number found (e.g. "Clause 3.1" or "Clause 4.3") or "General" if not specified.
6. Tone: Keep the answer clear, user-friendly, and conversational (general user language) rather than dense legalese, while strictly preserving all numbers, names, and facts.
7. Interaction: End your response by asking the user a friendly, contextual follow-up question related to their query to engage them.
8. Parent/Sub-Clauses: If the user asks about a parent clause (e.g. Clause 20, Clause 17, Clause 18, Clause 4) and the context contains its sub-clauses (e.g. 20.1, 20.2, 17.1, 4.3), treat the sub-clauses as part of the query and summarize/list their limits and details as the answer. Do not say you couldn't find the answer.`;

            userPrompt = `Context:\n${contextText}\n\nQuestion: ${question}\n\nAnswer JSON:`;
        }

        // ── 7. Call OpenAI GPT-4o ─────────────────────────────────────────────
        const completion = await openai.chat.completions.create({
            model: 'gpt-4o',
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user',   content: userPrompt }
            ],
            response_format: { type: 'json_object' },
            temperature: 0
        });
        
        let answer = "";
        let clause = "General";
        try {
            const responseData = JSON.parse(completion.choices[0].message.content);
            answer = responseData.answer;
            clause = responseData.clause || "General";
        } catch (jsonErr) {
            console.error("Failed to parse GPT JSON response:", jsonErr);
            answer = completion.choices[0].message.content;
        }

        // If the answer indicates information is not found, force confidence to Low (0%)
        const notFoundPatterns = [
            "couldn't find", "could not find", "cannot find", 
            "not found", "no information", "insufficient information", 
            "does not state", "not mention"
        ];
        const isNotFound = notFoundPatterns.some(pat => answer.toLowerCase().includes(pat));
        
        let buttonsHtml = "";
        if (isNotFound) {
            confidencePercentage = 0;
            clause = "-";
            buttonsHtml = `\n\nHere are some options you can explore:
<button class="chat-opt-btn" onclick="selectSuggestion('Who is approving authority under DOP clause 4.3 for Rs 2600000')">📊 Who is approving authority under DOP clause 4.3 for Rs 26 lakh?</button>
<button class="chat-opt-btn" onclick="selectSuggestion('who is approving authority under clause 4.1 for Rs 21 lakh')">💼 Who is approving authority under clause 4.1 for Rs 21 lakh?</button>
<button class="chat-opt-btn" onclick="selectSuggestion('what does clause 4.3 cover?')">📖 What does clause 4.3 cover?</button>
<button class="chat-opt-btn" onclick="selectSuggestion('what does ED stand for?')">🔍 What does ED stand for?</button>`;
            answer = `I couldn't find the answer in the provided documents.` + buttonsHtml;
        } else if (preComputedFact) {
            // Append dynamic threshold options
            const { clauseNum, targetLakh: tl } = preComputedFact;
            let nextAmount = tl === 26 ? 21 : 26;
            let otherClause = clauseNum === "4.3" ? "4.1" : "4.3";
            buttonsHtml = `\n\n<button class="chat-opt-btn" onclick="selectSuggestion('who is approving authority under clause ${clauseNum} for Rs ${nextAmount} lakh')">🔍 Check Rs ${nextAmount} lakh under Clause ${clauseNum}</button>
<button class="chat-opt-btn" onclick="selectSuggestion('who is approving authority under clause ${otherClause} for Rs 21 lakh')">💼 Check Clause ${otherClause} for Rs 21 lakh</button>
<button class="chat-opt-btn" onclick="selectSuggestion('what does clause ${clauseNum} cover?')">📖 What does Clause ${clauseNum} cover?</button>`;
            answer = answer + buttonsHtml;
        } else {
            // Append contextual follow-ups based on detected clause
            let detectedClause = clauseMatches[0] || (clause !== "General" ? clause.replace("Clause ", "") : null);
            if (detectedClause) {
                let otherClause = detectedClause.includes("4.3") ? "4.1" : "4.3";
                buttonsHtml = `\n\n<button class="chat-opt-btn" onclick="selectSuggestion('Who is approving authority under DOP clause ${detectedClause} for Rs 2600000')">📊 Who is approving authority under Clause ${detectedClause} for Rs 26 lakh?</button>
<button class="chat-opt-btn" onclick="selectSuggestion('who is approving authority under clause ${detectedClause} for Rs 2100000')">💼 Who is approving authority under Clause ${detectedClause} for Rs 21 lakh?</button>
<button class="chat-opt-btn" onclick="selectSuggestion('what does clause ${otherClause} cover?')">📖 What does Clause ${otherClause} cover?</button>`;
            } else {
                buttonsHtml = `\n\nHere are some options you can explore:
<button class="chat-opt-btn" onclick="selectSuggestion('Who is approving authority under DOP clause 4.3 for Rs 2600000')">📊 Who is approving authority under DOP clause 4.3 for Rs 26 lakh?</button>
<button class="chat-opt-btn" onclick="selectSuggestion('who is approving authority under clause 4.1 for Rs 21 lakh')">💼 Who is approving authority under clause 4.1 for Rs 21 lakh?</button>
<button class="chat-opt-btn" onclick="selectSuggestion('what does clause 4.3 cover?')">📖 What does clause 4.3 cover?</button>
<button class="chat-opt-btn" onclick="selectSuggestion('what does ED stand for?')">🔍 What does ED stand for?</button>`;
            }
            answer = answer + buttonsHtml;
        }
        
        // Match details for the stats cards
        const primarySource = topChunks[0];
        
        res.json({
            answer: answer,
            sourcePdf: isNotFound ? "-" : primarySource.docName,
            pageNumber: isNotFound ? "-" : primarySource.pageNumber.toString(),
            confidence: isNotFound ? "Low" : `${confidencePercentage}%`,
            clause: clause
        });
        
    } catch (err) {
        console.error("QA search endpoint error:", err);
        res.json({
            answer: `I'm having trouble connecting to the document database right now due to a temporary network issue. Let's try again in a moment.

In the meantime, you can explore these standard delegation of power areas:
<button class="chat-opt-btn" onclick="selectSuggestion('Who is approving authority under DOP clause 4.3 for Rs 2600000')">📊 Who is approving authority under DOP clause 4.3 for Rs 26 lakh?</button>
<button class="chat-opt-btn" onclick="selectSuggestion('who is approving authority under clause 4.1 for Rs 21 lakh')">💼 Who is approving authority under clause 4.1 for Rs 21 lakh?</button>
<button class="chat-opt-btn" onclick="selectSuggestion('what does clause 4.3 cover?')">📖 What does clause 4.3 cover?</button>
<button class="chat-opt-btn" onclick="selectSuggestion('what does ED stand for?')">🔍 What does ED stand for?</button>`,
            sourcePdf: "-",
            pageNumber: "-",
            confidence: "Low",
            clause: "-"
        });
    }
});

// Clean up: delete document chunks from Firestore when a document metadata is deleted
db.collection("documents").onSnapshot((snapshot) => {
    snapshot.docChanges().forEach(async (change) => {
        if (change.type === "removed") {
            const docId = change.doc.id;
            const docData = change.doc.data();
            console.log(`Document "${docData.name}" removed from Firestore. Deleting associated chunks...`);
            
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
        }
    });
});

// Start Server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`RAG backend server is listening on port ${PORT}...`);
});
