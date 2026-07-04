/**
 * Re-index clause tags for all existing chunks in Firestore.
 * This patches the `clauses` array on every chunk doc to include
 * letter sub-clauses (15(a), 15a, 15.a etc.) that were missed during original ingestion.
 * Also adds numeric parents that were missing (e.g. 18, 26).
 * DOES NOT re-embed or re-parse PDFs — only updates the `clauses` metadata field.
 */
const admin = require('firebase-admin');
const path = require('path');
const serviceAccount = require(path.join(__dirname, '..', 'service-account.json'));
if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();

function extractClauses(chunkText) {
    const clauseSet = new Set();
    const siRegex = /\[SI:\s*([^\]]+)\]/gi;
    let siMatch;
    siRegex.lastIndex = 0;
    while ((siMatch = siRegex.exec(chunkText)) !== null) {
        const val = siMatch[1].trim();
        // Always store the numeric part (e.g. "18.1") and its integer parent ("18")
        const numOnly = val.match(/^(\d+(?:\.\d+)?)/);
        if (numOnly) {
            clauseSet.add(numOnly[1]);
            const intParent = numOnly[1].split('.')[0];
            clauseSet.add(intParent);
        }
        // Store with letter if present: "15(a)", "15a", "3A", "17.1(b)"
        const withLetter = val.match(/^(\d+(?:\.\d+)?)\s*\(?([a-z])\)?/i);
        if (withLetter) {
            const num = withLetter[1];
            const letter = withLetter[2].toLowerCase();
            clauseSet.add(`${num}(${letter})`);
            clauseSet.add(`${num}${letter}`);
            clauseSet.add(`${num}.${letter}`);
            // Also store under integer parent
            const iParent = num.split('.')[0];
            clauseSet.add(`${iParent}(${letter})`);
            clauseSet.add(`${iParent}${letter}`);
            clauseSet.add(`${iParent}.${letter}`);
        }
    }
    return Array.from(clauseSet);
}

async function run() {
    const snap = await db.collection("chunks").get();
    console.log(`Total chunks to process: ${snap.size}`);
    
    let updated = 0, skipped = 0, errors = 0;
    const BATCH_SIZE = 400; // Firestore batch write limit
    let batch = db.batch();
    let batchCount = 0;
    
    for (const doc of snap.docs) {
        const data = doc.data();
        const text = data.text || '';
        const newClauses = extractClauses(text);
        const oldClauses = data.clauses || [];
        
        // Only update if clauses changed
        const oldSet = new Set(oldClauses);
        const newSet = new Set(newClauses);
        const hasChange = newClauses.some(c => !oldSet.has(c)) || oldClauses.some(c => !newSet.has(c));
        
        if (!hasChange) { skipped++; continue; }
        
        batch.update(doc.ref, { clauses: newClauses });
        batchCount++;
        updated++;
        
        if (batchCount >= BATCH_SIZE) {
            await batch.commit();
            console.log(`  Committed batch of ${batchCount}`);
            batch = db.batch();
            batchCount = 0;
        }
    }
    
    if (batchCount > 0) {
        await batch.commit();
        console.log(`  Committed final batch of ${batchCount}`);
    }
    
    console.log(`\nDone! Updated: ${updated}, Skipped (no change): ${skipped}, Errors: ${errors}`);
    
    // Verify results
    console.log("\n--- Verification ---");
    const verSnap = await db.collection("chunks").get();
    const allClauses = new Set();
    verSnap.forEach(doc => {
        (doc.data().clauses || []).forEach(c => allClauses.add(c));
    });
    const withLetters = [...allClauses].filter(c => /^\d+.*[a-z]/i.test(c)).sort();
    const topLevel = [...allClauses].filter(c => /^\d+$/.test(c)).map(Number).sort((a,b)=>a-b);
    console.log("Top-level clauses:", topLevel.join(', '));
    console.log("Letter sub-clauses:", withLetters.slice(0, 30).join(', '), withLetters.length > 30 ? `... (${withLetters.length} total)` : '');
}

run().then(() => process.exit(0)).catch(err => { console.error('FATAL:', err); process.exit(1); });
