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

// Serve specific static frontend assets to prevent exposing backend secrets like .env, service-account.json, etc.
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});
app.get('/index.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});
app.get('/admin.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});
app.use('/js', express.static(path.join(__dirname, 'js')));
app.use('/document-qa-system-main', express.static(path.join(__dirname, 'document-qa-system-main')));


// Initialize OpenAI client
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

// Initialize Firebase Admin SDK
// Supports two modes:
// 1. Cloud deployment (Render.com): reads credentials from FIREBASE_SERVICE_ACCOUNT env var (JSON string)
// 2. Local development: reads from service-account.json file
let serviceAccount;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    try {
        serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        console.log("Firebase: loaded credentials from FIREBASE_SERVICE_ACCOUNT env var.");
    } catch (e) {
        console.error("CRITICAL ERROR: FIREBASE_SERVICE_ACCOUNT env var is not valid JSON!", e.message);
        process.exit(1);
    }
} else {
    const serviceAccountPath = path.join(__dirname, 'service-account.json');
    if (!fs.existsSync(serviceAccountPath)) {
        console.error("CRITICAL ERROR: 'service-account.json' not found and FIREBASE_SERVICE_ACCOUNT env var is not set!");
        console.error("For cloud deployment: set FIREBASE_SERVICE_ACCOUNT env var in your hosting platform.");
        console.error("For local development: place service-account.json in the project root.");
        process.exit(1);
    }
    serviceAccount = require(serviceAccountPath);
    console.log("Firebase: loaded credentials from service-account.json file.");
}

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    storageBucket: "robotic-af198.firebasestorage.app"
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

function expandClauseTargets(clauseNum) {
    const targets = new Set();
    targets.add(clauseNum);

    // Case A: Nested decimal clause with or without letter (e.g. "17.1(b)", "17.1b", "17.1", "4.3")
    const decimalMatch = clauseNum.match(/^(\d+)\.(\d+)(?:\(([a-z])\)|([a-z]))?$/i);
    if (decimalMatch) {
        const parent = decimalMatch[1];
        const sub = decimalMatch[2];
        const letter = decimalMatch[3] || decimalMatch[4];
        
        const parentDecimal = `${parent}.${sub}`;
        targets.add(parentDecimal);
        targets.add(parent);
        
        // Add dotted siblings 1 to 8
        for (let i = 1; i <= 8; i++) {
            targets.add(`${parent}.${i}`);
        }
        
        // If it has a subclause letter (e.g., "17.1(b)"), expand it with parenthetical/alpha variants
        if (letter) {
            const letters = ['a', 'b', 'c', 'd', 'e', 'f'];
            letters.forEach(let => {
                targets.add(`${parentDecimal}(${let})`);
                targets.add(`${parentDecimal}${let}`);
                targets.add(`${parentDecimal}.${let}`);
            });
        }
    }

    // Case B: Integer clause with sub-clause letter (e.g. "15(b)", "15b", "9A")
    const parenMatch = clauseNum.match(/^(\d+)(?:\(([a-z])\)|([a-z]))$/i);
    if (parenMatch) {
        const parent = parenMatch[1];
        targets.add(parent);
        // Add siblings a to f
        const letters = ['a', 'b', 'c', 'd', 'e', 'f'];
        letters.forEach(let => {
            targets.add(`${parent}(${let})`);
            targets.add(`${parent}${let}`);
            targets.add(`${parent}.${let}`);
        });
    }

    // Case C: Integer parent clause itself (e.g. "4", "15")
    const parentMatch = clauseNum.match(/^(\d+)$/);
    if (parentMatch) {
        const parent = parentMatch[1];
        // Add decimal sub-clauses 1 to 8
        for (let i = 1; i <= 8; i++) {
            targets.add(`${parent}.${i}`);
        }
        // Add alphabetical sub-clauses
        const letters = ['a', 'b', 'c', 'd', 'e', 'f'];
        letters.forEach(let => {
            targets.add(`${parent}(${let})`);
            targets.add(`${parent}${let}`);
            targets.add(`${parent}.${let}`);
        });
    }

    return Array.from(targets);
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
    // Only extract standalone numbers as amounts if they are large (>= 10000)
    // This avoids extracting simple clause numbers (e.g. "clause 10") as amounts
    let temp = q.replace(/\b\d+\.\d+\b/g, '');
    const anyNumRegex = /\b(\d+)\b/g;
    anyNumRegex.lastIndex = 0;
    while ((match = anyNumRegex.exec(temp)) !== null) {
        const val = parseFloat(match[1]);
        if (val >= 10000) {
            return val / 100000;
        }
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

                        // Clean and tokenize chunk text to extract meaningful keywords for hybrid search
                        const keywordSet = new Set();
                        const chunkWords = chunkText.toLowerCase()
                            .replace(/[.,?/()'"\[\]:|]/g, ' ')
                            .split(/\s+/);
                        
                        const chunkStopwords = new Set([
                            'what', 'is', 'the', 'of', 'for', 'under', 'in', 'to', 'and', 'or', 'a', 'an', 'this', 'that', 'these', 'those',
                            'context', 'document', 'page', 'table', 'columns', 'ed', 'gm', 'agm', 'dgm', 'sm', 'powers', 'nil', 'upto'
                        ]);

                        for (const w of chunkWords) {
                            const clean = w.trim();
                            if (clean.length >= 3 && clean.length <= 15 && !chunkStopwords.has(clean) && !/^\d+$/.test(clean)) {
                                keywordSet.add(clean);
                            }
                        }
                        const tags = Array.from(keywordSet).slice(0, 50);

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
                            clauses: clauses,
                            tags: tags,
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

function formatAnswer(text) {
    if (!text) return "";
    return text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
}

function extractKeywords(text) {
    const stopwords = new Set([
        'what', 'is', 'the', 'of', 'for', 'under', 'who', 'approving', 'authority', 'clause',
        'does', 'stand', 'how', 'can', 'i', 'help', 'you', 'today', 'are', 'some',
        'options', 'explore', 'check', 'rs', 'lakh', 'crore', 'in', 'to', 'and', 'or', 'a',
        'an', 'this', 'that', 'these', 'those', 'where', 'when', 'why', 'which', 'about', 'from',
        'document', 'documents', 'manual', 'manuals', 'policy', 'policies'
    ]);
    const words = text.toLowerCase()
        .replace(/[.,?/()'"\[\]:|]/g, ' ')
        .split(/\s+/);
    const keywords = [];
    for (const w of words) {
        const clean = w.trim();
        if (clean.length > 2 && !stopwords.has(clean) && !/^\d+$/.test(clean)) {
            keywords.push(clean);
        }
    }
    return keywords;
}

// Search API Endpoint: /ask
app.post('/ask', async (req, res) => {
    const { question } = req.body;
    
    if (!question || question.trim() === "") {
        return res.status(400).json({ error: "Question cannot be empty." });
    }
    
    // Detect if the query is in Hindi (either via Devanagari script range or transliterated keywords)
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

    // ── 0. Handle Greetings and Short Queries Conversational style ──
    const lowerQ = question.trim().toLowerCase().replace(/[?,.]/g, '');
    const isGreeting = /^(hi|hello|hey|good\s+morning|good\s+afternoon|good\s+evening|greetings|yo|help|sup|नमस्ते|नमस्कार|हेलो|प्रणाम)(\s+.*)?$/i.test(lowerQ);
    if (isGreeting) {
        try {
            const completion = await openai.chat.completions.create({
                model: 'gpt-4o-mini',
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
            return res.json({
                answer: formatAnswer(answerText),
                sourcePdf: "-",
                pageNumber: "-",
                confidence: "100%",
                clause: "Greeting"
            });
        } catch (err) {
            console.error("GPT greeting helper error:", err);
            // Fallback to static greeting
            const fallbackHindi = `नमस्ते! मैं आपका **दस्तावेज़ एआई सहायक (Document AI Assistant)** हूँ।

आज मैं आपकी क्या सहायता कर सकता हूँ?

यहाँ कुछ विकल्प दिए गए हैं जिन्हें आप देख सकते हैं:
<button class="chat-opt-btn" onclick="selectSuggestion('DOP क्लॉज 4.3 के तहत 26 lakh रुपये के लिए मंजूरी देने वाला प्राधिकारी कौन है')">📊 DOP क्लॉज 4.3 के तहत 26 लाख रुपये के लिए मंजूरी देने वाला प्राधिकारी कौन है?</button>
<button class="chat-opt-btn" onclick="selectSuggestion('क्लॉज 4.1 के तहत 21 lakh रुपये के लिए मंजूरी देने वाला प्राधिकारी कौन है')">💼 क्लॉज 4.1 के तहत 21 लाख रुपये के लिए मंजूरी देने वाला प्राधिकारी कौन है?</button>
<button class="chat-opt-btn" onclick="selectSuggestion('क्लॉज 4.3 में क्या शामिल है')">📖 क्लॉज 4.3 में क्या शामिल है?</button>
<button class="chat-opt-btn" onclick="selectSuggestion('ED का क्या अर्थ है')">🔍 ED का क्या अर्थ है?</button>

आप इनमें से किसी भी विकल्प पर क्लिक कर सकते हैं या अपना प्रश्न पूछ सकते हैं!`;

            const fallbackEnglish = `Hello! I am your **Document AI Assistant**.

How can I help you today?

Here are some options you can explore:
<button class="chat-opt-btn" onclick="selectSuggestion('Who is approving authority under DOP clause 4.3 for Rs 2600000')">📊 Who is approving authority under DOP clause 4.3 for Rs 26 lakh?</button>
<button class="chat-opt-btn" onclick="selectSuggestion('who is approving authority under clause 4.1 for Rs 21 lakh')">💼 Who is approving authority under clause 4.1 for Rs 21 lakh?</button>
<button class="chat-opt-btn" onclick="selectSuggestion('what does clause 4.3 cover?')">📖 What does clause 4.3 cover?</button>
<button class="chat-opt-btn" onclick="selectSuggestion('what does ED stand for?')">🔍 What does ED stand for?</button>

Feel free to click any of these options or ask your own question!`;

            return res.json({
                answer: formatAnswer(isHindiQuery ? fallbackHindi : fallbackEnglish),
                sourcePdf: "-",
                pageNumber: "-",
                confidence: "100%",
                clause: "Greeting"
            });
        }
    }
    
    try {
        console.log(`Searching answers for query: "${question}"...`);

        // Normalize Hindi terms to English equivalents for extraction and matching
        let normalizedQuestion = question.toLowerCase()
            .replace(/(?:रुपये|रुपए|रुपया|रु\.?|रू\.?)/g, 'rs')
            .replace(/(?:लाख|ल\b)/g, 'lakh')
            .replace(/(?:करोड़|करोड|सीआर\b)/g, 'crore')
            .replace(/(?:क्लॉज|क्लाज|धारा)/g, 'clause');

        // Standardize all forms of subclauses (e.g. "15 (b)", "15 B", "15 . b" to "15(b)", "15b", "15.b")
        let prev;
        do {
            prev = normalizedQuestion;
            normalizedQuestion = normalizedQuestion
                .replace(/(\d+)\s*\(\s*([a-z])\s*\)/g, '$1($2)')
                .replace(/(\d+)\s*\.\s*([a-z\d]+)/g, '$1.$2')
                .replace(/\b(\d+)\s+([a-z])\b/g, '$1$2')
                .replace(/(\d+)\s*(?:sub\s*[-]?\s*clause|part|section|item|no\.?)\s*([a-z])\b/g, '$1$2')
                .replace(/(\d+)\s*[\/-]\s*([a-z])\b/g, '$1$2');
        } while (normalizedQuestion !== prev);
        
        // Extract section/clause numbers with parenthetical matching
        const clauseRegex = /\b(?:clause|cl|section|si|item|s\.no|no\.?|number)\s+(\d+\.\d+(?:\([a-z]\))?|\d+\s*[a-z]?|\d+(?:\([a-z]\))?|\d+)(?!\w)|(\b\d+\.\d+(?:\([a-z]\))?\b|\b\d+\([a-z]\)(?!\w))/gi;
        let clauseMatches = [], match;
        while ((match = clauseRegex.exec(normalizedQuestion)) !== null) {
            if (match[1]) clauseMatches.push(match[1]);
            else if (match[2]) clauseMatches.push(match[2]);
        }
        console.log(`Extracted clause numbers from query:`, clauseMatches);

        const queryKeywords = extractKeywords(question);
        console.log(`Extracted query keywords:`, queryKeywords);

        let directChunks = [];
        // Expand targets to include parent and siblings (so remarks under the last subclause are fetched)
        let clauseTargets = [];
        clauseMatches.forEach(cl => {
            expandClauseTargets(cl).forEach(t => {
                if (!clauseTargets.includes(t)) {
                    clauseTargets.push(t);
                }
            });
        });
        clauseTargets = clauseTargets.slice(0, 30); // Firestore array-contains-any limit

        if (clauseTargets.length > 0) {
            try {
                const directQuery1 = db.collection("chunks").where("clauses", "array-contains-any", clauseTargets);
                const snap1 = await directQuery1.get();
                snap1.forEach(doc => {
                    directChunks.push({ id: doc.id, ...doc.data() });
                });
                console.log(`Direct metadata query found ${directChunks.length} chunks matching clauses:`, clauseTargets);
            } catch (err) {
                console.error("Direct metadata query error:", err);
            }
        }

        let topChunks = [];
        let confidencePercentage = 100;
        let highestSimilarity = 1.0;

        if (directChunks.length > 0) {
            // We have direct exact matches! Bypass generating query embedding.
            let allChunks = directChunks.map(chunkData => ({
                ...chunkData,
                rawSimilarity: 1.0,
                boostedSimilarity: 1.0,
                isExactClauseMatch: true
            }));
            allChunks.sort((a, b) => a.pageNumber - b.pageNumber);
            topChunks = allChunks.slice(0, 8);
            console.log(`Bypassed embedding creation. Using ${topChunks.length} direct clause chunks.`);
        } else {
            // Fallback: Generate query embedding and perform vector search
            console.log("No direct clause matches. Generating query embedding for vector search...");
            const queryEmbeddingResponse = await openai.embeddings.create({
                model: "text-embedding-3-small",
                input: question
            });
            const queryEmbedding = queryEmbeddingResponse.data[0].embedding;

            let keywordChunks = [];
            const keywordTargets = [...queryKeywords].slice(0, 10);
            if (keywordTargets.length > 0) {
                try {
                    const directQuery2 = db.collection("chunks").where("tags", "array-contains-any", keywordTargets);
                    const snap2 = await directQuery2.get();
                    snap2.forEach(doc => {
                        keywordChunks.push({ id: doc.id, ...doc.data() });
                    });
                } catch (err) {
                    console.error("Keyword metadata query error:", err);
                }
            }

            const query = db.collection("chunks").findNearest({
                vectorField: 'embedding',
                queryVector: queryEmbedding,
                limit: 150,
                distanceMeasure: 'COSINE'
            });

            const chunksSnap = await query.get();
            if (chunksSnap.empty && keywordChunks.length === 0) {
                return res.json({
                    answer: formatAnswer(isHindiQuery 
                        ? "अभी तक कोई दस्तावेज़ अपलोड या अनुक्रमित नहीं किया गया है। कृपया एडमिन पैनल पर जाएं और पीडीएफ अपलोड करें।" 
                        : "No documents have been uploaded or indexed yet. Please go to the admin panel and upload PDFs."),
                    sourcePdf: "-",
                    pageNumber: "-",
                    confidence: "-",
                    clause: "-"
                });
            }
            
            // Merge vector and direct search results, removing duplicates
            const mergedChunksMap = new Map();
            keywordChunks.forEach(c => {
                mergedChunksMap.set(c.id, c);
            });
            chunksSnap.forEach(doc => {
                if (!mergedChunksMap.has(doc.id)) {
                    mergedChunksMap.set(doc.id, { id: doc.id, ...doc.data() });
                }
            });

            // 3. Build all chunks with cosine similarity and keyword boosting
            let allChunks = [];
            mergedChunksMap.forEach((chunkData) => {
                const vec = chunkData.embedding ? chunkData.embedding.toArray() : [];
                const similarity = vec.length > 0 ? cosineSimilarity(queryEmbedding, vec) : 0;
                let isExactClauseMatch = false;

                for (const clauseNum of clauseMatches) {
                    if (chunkData.clauses && chunkData.clauses.includes(clauseNum)) {
                        isExactClauseMatch = true;
                        break;
                    }
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
            topChunks = allChunks.slice(0, 8);

            const topDoc = topChunks[0];
            highestSimilarity = topDoc.boostedSimilarity || topDoc.rawSimilarity || 0.99;
            confidencePercentage = 100;
            console.log(`Top chunk: raw=${topDoc.rawSimilarity?.toFixed(4)}, boosted=${topDoc.boostedSimilarity?.toFixed(4)}, exactClauseMatch=${topDoc.isExactClauseMatch} -> confidence: ${confidencePercentage}%`);
            
            if (highestSimilarity < 0.20) {
                const fallbackHindi = `मैं आपका दस्तावेज़ एआई सहायक (Document AI Assistant) हूँ, जो अपलोड किए गए डेलीगेशन ऑफ पावर्स (DOP) मैनुअल में विशेषज्ञता रखता है। मैं केवल इन दस्तावेजों से संबंधित प्रश्नों के उत्तर दे सकता हूँ (जैसे मंजूरी देने वाले प्राधिकारी, वित्तीय सीमाएं और नीति नियम)। कृपया DOP मैनुअल से संबंधित प्रश्न पूछें।${optionsHindi}`;
                const fallbackEnglish = `I am your Document AI Assistant, specialized in the uploaded Delegation of Powers (DOP) policy manuals. I can only answer questions related to these documents (such as approval authorities, threshold limits, and policy clauses). Please submit a query related to the DOP manuals.${optionsEnglish}`;
                
                return res.json({
                    answer: formatAnswer(isHindiQuery ? fallbackHindi : fallbackEnglish),
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

                // Zero-Latency Local Formatting Bypass
                const targetDisplay = targetLakh >= 100 ? `Rs. ${(targetLakh / 100).toFixed(targetLakh % 100 === 0 ? 0 : 2)} crore` : `Rs. ${targetLakh} lakh`;
                let answerText = "";
                let buttonsHtml = "";
                const otherClause = clauseNum.startsWith("4") ? (clauseNum === "4.3" ? "4.1" : "4.3") : "4.3";

                if (isHindiQuery) {
                    answerText = `**क्लॉज ${clauseNum}** के तहत, **${targetDisplay}** की राशि के लिए सक्षम प्राधिकारी **${authority.name}** हैं (उनकी मंजूरी सीमा: **${authority.limitText}**)।`;
                    buttonsHtml = `\n\n<button class="chat-opt-btn" onclick="selectSuggestion('who is approving authority under clause ${clauseNum} for Rs 21 lakh')">💼 क्या क्लॉज ${clauseNum} के तहत 21 लाख रुपये के लिए मंजूरी मिल सकती है?</button>
<button class="chat-opt-btn" onclick="selectSuggestion('what does clause ${otherClause} cover?')">📖 क्लॉज ${otherClause} में क्या शामिल है?</button>`;
                } else {
                    answerText = `Under **Clause ${clauseNum}**, the competent approving authority for **${targetDisplay}** is the **${authority.name}** (approval limit: **${authority.limitText}**).`;
                    buttonsHtml = `\n\n<button class="chat-opt-btn" onclick="selectSuggestion('who is approving authority under clause ${clauseNum} for Rs 21 lakh')">💼 Check Rs 21 lakh under Clause ${clauseNum}</button>
<button class="chat-opt-btn" onclick="selectSuggestion('what does clause ${otherClause} cover?')">📖 What does Clause ${otherClause} cover?</button>`;
                }

                return res.json({
                    answer: formatAnswer(answerText + buttonsHtml),
                    sourcePdf: topChunks.length > 0 ? topChunks[0].docName : "-",
                    pageNumber: topChunks.length > 0 ? topChunks[0].pageNumber.toString() : "-",
                    confidence: "100%",
                    clause: `Clause ${clauseNum}`
                });
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

            systemPrompt = `You are a helpful, conversational document assistant. Write an extremely direct, pinpointed, and clear answer using ONLY the facts provided. Keep the response under 60 words and focused strictly on answering the specific question. Do NOT explain or show delegation limits/powers of other authorities not requested. Do NOT list the limits of other authorities. Note: Remarks listed at the end of a main clause (e.g. below 4.3 or below 15) apply to all of its sub-clauses (e.g. 4.1, 4.2, 4.3). Respond with JSON: {"answer": "...", "clause": "Clause ${clauseNum}"}`;
            userPrompt = `VERIFIED FACTS:
- Clause: ${clauseNum} — ${clauseRow.Nature || 'Delegation of Powers'}
- Query amount: ${targetDisplay}
- COMPETENT AUTHORITY: ${authority.name}
- Their limit: ${authority.limitText}
${lowerReasons ? `- Cannot approve: ${lowerReasons}` : ''}

CONTEXT FROM DOCUMENT (contains Remarks/Notes/Exceptions):
${contextText}

Instructions:
1. Answer the question directly and pinpointedly in 1-2 short sentences. State only the competent authority and their limit for the queried amount. Do NOT list or mention the limits/powers of other authorities, and do NOT output a table of delegation limits.
2. If there is a critical exception/remark directly affecting this specific approval (e.g. remarks listed under 4.3 apply to 4.1, 4.2, 4.3 as well), mention it in one very brief sentence. Otherwise, do not include generic remarks.
${isHindiQuery ? "Write the entire response in Hindi (Devanagari script), keeping exact names/limits/clause numbers bolded." : ""}
3. Do not alter any numbers or authority names.
Answer JSON:`;

        } else {
            systemPrompt = `You are an expert AI assistant for company policy documents.
CRITICAL INSTRUCTIONS FOR 100% ACCURACY, READABILITY, AND NO HALLUALUCINATIONS:
1. Grounding: Answer the question using ONLY the facts explicitly stated in the provided context blocks. Keep your response concise, clear, and under 150 words.
2. No Hallucinations: If the context doesn't contain the answer, say "I couldn't find the answer in the provided documents."
3. Exact Match: Do not alter any clause numbers, numbers, amounts, percentages, names, or quotes. They must be copied exactly from the context.
4. Abbreviations: ED = Executive Director, GM = General Manager, AGM = Additional General Manager, DGM = Deputy General Manager, SM = Senior Manager.
5. Format: Respond with JSON format strictly: {"answer": "...", "clause": "..."}. Fill "clause" with the specific clause number found (e.g. "Clause 3.1" or "Clause 4.3") or "General" if not specified.
6. Paragraphs and Formatting: Structure your response in multiple short, distinct paragraphs (separated by double newlines '\\n\\n') to improve readability. Keep it under 150 words. Use markdown **bolding** for key terms.
7. General/Parent/Sub-Clauses: If the user asks about a general clause (e.g. Clause 1, Clause 15, Clause 4, Clause 10) and there are multiple sub-clauses (e.g. 1(a), 1(b), 1(c), 1(d) or 15(a), 15(b) or 4.1, 4.2) in the context, you MUST present a high-level summary of all sub-clauses and politely ask if they would like details on a specific sub-clause. If they query specifically about Clause 1, you MUST ask which sub-clause of Clause 1 they want, listing 1(a), 1(b), 1(c), 1(d) etc., with interactive buttons.
8. Interactive Buttons: If recommending or prompting for specific sub-clauses, you should output interactive HTML buttons inside your "answer" field for them, formatted exactly like: <button class="chat-opt-btn" onclick="selectSuggestion('tell me about clause 1(a)')">📖 Details for Clause 1(a)</button>.
9. Remarks and Notes: You MUST always take into account and include any "Remarks" or "Notes" associated with the clauses you are explaining, as they contain critical exceptions, limits, or conditions. Note that Remarks/Notes listed at the end of a clause (e.g. below 4.3 or below 15) apply to all of its sub-clauses (e.g. 4.1, 4.2, 4.3 or 15(a), 15(b)). Apply them accordingly.
10. End with a friendly follow-up question.
${isHindiQuery ? "Write your entire response in Hindi (Devanagari script)." : ""}`;

            userPrompt = `Context:\n${contextText}\n\nQuestion: ${question}\n\nAnswer JSON:`;
        }

        // ── 7. Call OpenAI GPT-4o ─────────────────────────────────────────────
        const completion = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
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
            "couldn't find", "could not find", "cannot find", "not found",
            "no information", "insufficient information", "does not state", "not mention",
            "unable to", "can't find", "cannot answer", "don't know", "do not know", "no data",
            "नहीं मिला", "जानकारी नहीं है", "प्रासंगिक जानकारी नहीं", "उत्तर नहीं मिल", "असमर्थ"
        ];
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
                answer = `मैं यहाँ आपको डेलीगेशन ऑफ पावर्स (DOP) मैनुअल को समझने में मदद करने के लिए हूँ। क्या आप कृपया स्पष्ट रूप से बता सकते हैं कि आप क्या पूछना चाहते हैं?` + buttonsHtml;
            } else {
                buttonsHtml = optionsEnglish;
                answer = `I am here to help you navigate the Delegation of Powers (DOP) manual. Could you please specify exactly what you would like to know?` + buttonsHtml;
            }
        } else if (preComputedFact) {
            // Append dynamic threshold options
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
            // Append contextual follow-ups based on detected clause
            let detectedClause = clauseMatches[0] || (clause !== "General" ? clause.replace("Clause ", "") : null);
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
        
        // Match details for the stats cards
        const primarySource = topChunks[0];
        
        res.json({
            answer: formatAnswer(answer),
            sourcePdf: isNotFound ? "-" : primarySource.docName,
            pageNumber: isNotFound ? "-" : primarySource.pageNumber.toString(),
            confidence: isNotFound ? "Low" : `${confidencePercentage}%`,
            clause: clause
        });
        
    } catch (err) {
        console.error("QA search endpoint error:", err);
        const errorFallbackTextHindi = `मुझे इस समय डेटाबेस से कनेक्ट करने में समस्या हो रही है। कृपया एक क्षण में पुन: प्रयास करें।
        
इस बीच, आप इन क्षेत्रों की जांच कर सकते हैं:`;
        const errorFallbackTextEnglish = `I'm having trouble connecting to the document database right now due to a temporary network issue. Let's try again in a moment.

In the meantime, you can explore these standard delegation of power areas:`;
        res.json({
            answer: (isHindiQuery ? errorFallbackTextHindi : errorFallbackTextEnglish) + (isHindiQuery ? optionsHindi : optionsEnglish),
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
app.listen(PORT, '0.0.0.0', () => {
    console.log(`RAG backend server is listening on port ${PORT}...`);
});
