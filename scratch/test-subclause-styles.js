/**
 * Validate that all sub-clause query styles resolve correctly.
 * Tests all combinations: 1d, 1 d, 1(d), 1 (d), 1D, 1 D, etc.
 */
const admin = require('firebase-admin');
const path = require('path');
const serviceAccount = require(path.join(__dirname, '..', 'service-account.json'));
if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();

// Paste the updated normalization and expandClauseTargets from server.js
const LETTERS = 'abcdefghijklmnopqrstuvwxyz'.split('');

function normalize(question) {
    let q = question.toLowerCase()
        .replace(/(?:रुपये|रुपए|रुपया|रु\.?|रू\.?)/g, 'rs')
        .replace(/(?:लाख|ल\b)/g, 'lakh')
        .replace(/(?:करोड़|करोड|सीआर\b)/g, 'crore')
        .replace(/(?:क्लॉज|क्लाज|धारा)/g, 'clause');
    let prev;
    do {
        prev = q;
        q = q
            .replace(/(\d+)\s*\(\s*([a-z])\s*\)/gi, (_, n, l) => `${n}(${l.toLowerCase()})`)
            .replace(/(\d+)\s*\.\s*([a-z\d]+)/gi, '$1.$2')
            .replace(/\b(\d+)\s+([a-z])\b/gi, (_, n, l) => `${n}${l.toLowerCase()}`)
            .replace(/(\d+)\s*(?:sub\s*[-]?\s*clause|subclause|part|section|item|no\.?)\s*([a-z])\b/gi, (_, n, l) => `${n}${l.toLowerCase()}`)
            .replace(/(\d+)\s*[\/\-]\s*([a-z])\b/gi, (_, n, l) => `${n}${l.toLowerCase()}`);
    } while (q !== prev);
    return q;
}

function extractClauses(normalizedQ) {
    const clauseRegex = /\b(?:clause|cl|section|si|item|s\.no|no\.?|number)\s+(\d+\.\d+(?:\([a-z]\))?|\d+\s*[a-z]?|\d+(?:\([a-z]\))?|\d+)(?!\w)|(\b\d+\.\d+(?:\([a-z]\))?\b|\b\d+\([a-z]\)(?!\w))/gi;
    const clauseMatches = [];
    let match;
    while ((match = clauseRegex.exec(normalizedQ)) !== null) {
        if (match[1]) clauseMatches.push(match[1]);
        else if (match[2]) clauseMatches.push(match[2]);
    }
    return clauseMatches;
}

function expandClauseTargets(clauseNum) {
    const targets = new Set();
    targets.add(clauseNum);
    const decimalMatch = clauseNum.match(/^(\d+)\.(\d+)(?:\(([a-z])\)|([a-z]))?$/i);
    if (decimalMatch) {
        const parent = decimalMatch[1];
        const sub = decimalMatch[2];
        const letter = (decimalMatch[3] || decimalMatch[4] || '').toLowerCase();
        const parentDecimal = `${parent}.${sub}`;
        targets.add(parentDecimal);
        targets.add(parent);
        for (let i = 1; i <= 8; i++) targets.add(`${parent}.${i}`);
        if (letter) LETTERS.forEach(l => { targets.add(`${parentDecimal}(${l})`); targets.add(`${parentDecimal}${l}`); targets.add(`${parentDecimal}.${l}`); });
    }
    const parenMatch = clauseNum.match(/^(\d+)(?:\(([a-z])\)|([a-z]))$/i);
    if (parenMatch) {
        const parent = parenMatch[1];
        targets.add(parent);
        LETTERS.forEach(l => { targets.add(`${parent}(${l})`); targets.add(`${parent}${l}`); targets.add(`${parent}.${l}`); });
    }
    const parentMatch = clauseNum.match(/^(\d+)$/);
    if (parentMatch) {
        const parent = parentMatch[1];
        for (let i = 1; i <= 8; i++) targets.add(`${parent}.${i}`);
        LETTERS.forEach(l => { targets.add(`${parent}(${l})`); targets.add(`${parent}${l}`); targets.add(`${parent}.${l}`); });
    }
    return Array.from(targets);
}

const testCases = [
    "what is sub clause d of clause 1",
    "clause 1d",
    "clause 1 d",
    "clause 1(d)",
    "clause 1 (d)",
    "clause 1D",
    "clause 1 D",
    "clause 1-d",
    "clause 1/d",
    "clause 15(a)",
    "clause 15 a",
    "clause 15A",
    "clause 15 A",
    "clause 15-a",
    "what does clause 15 sub clause b say",
    "clause 15 part b",
];

async function run() {
    const snap = await db.collection("chunks").get();
    const allDocs = [];
    snap.forEach(doc => allDocs.push({ id: doc.id, ...doc.data() }));
    console.log(`Loaded ${allDocs.length} chunks for testing.\n`);

    for (const q of testCases) {
        const norm = normalize(q);
        const clauses = extractClauses(norm);
        const targets = [];
        clauses.forEach(cl => expandClauseTargets(cl).forEach(t => { if (!targets.includes(t)) targets.push(t); }));
        const matched = allDocs.filter(d => (d.clauses || []).some(c => targets.includes(c)));
        console.log(`Query: "${q}"`);
        console.log(`  → Normalized: "${norm}"`);
        console.log(`  → Extracted clauses: [${clauses.join(', ')}]`);
        console.log(`  → Matched chunks: ${matched.length}`);
        console.log('');
    }
}

run().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
