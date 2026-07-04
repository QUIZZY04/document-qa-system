const admin = require('firebase-admin');
const path = require('path');
const serviceAccount = require(path.join(__dirname, '..', 'service-account.json'));
if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

function extractPageClauses(text, pageNum) {
    const clauseSet = new Set();
    const lines = text.split('\n');
    
    const pageParentMap = {
        3: "1", 4: "2", 5: "3", 6: "3", 7: "4", 8: "5", 9: "5",
        10: "6", 11: "6", 12: "7b", 13: "8", 14: "8", 15: "9",
        16: "11", 17: "13", 18: "15", 19: "15", 20: "17", 21: "17",
        22: "18", 23: "20", 24: "22", 25: "24", 26: "26"
    };
    
    let activeParent = pageParentMap[pageNum] || null;
    let activeSubParent = null;

    for (const line of lines) {
        const siMatch = line.match(/\[SI:\s*([^\]]+)\]/i);
        if (!siMatch) continue;
        
        const val = siMatch[1].trim();
        
        // 1. Major parent clause
        const numMatch = val.match(/^(\d+(?:\.\d+)?)/);
        if (numMatch) {
            const rawNum = numMatch[1];
            activeParent = rawNum;
            activeSubParent = null;
            clauseSet.add(rawNum);
            clauseSet.add(rawNum.split('.')[0]);
        }
        
        // 2. Sub-clause letter
        const letterMatch = val.match(/^([a-z])\)/i);
        if (letterMatch && activeParent) {
            const letter = letterMatch[1].toLowerCase();
            activeSubParent = letter;
            clauseSet.add(`${activeParent}(${letter})`);
            clauseSet.add(`${activeParent}${letter}`);
            clauseSet.add(`${activeParent}.${letter}`);
        }
        
        // 3. Sub-items
        const cleanVal = val.replace(/^([a-z])\)/i, '');
        const items = [];
        const itemRegex = /\b(i+|v|x|[a-z])\b/gi;
        let m;
        while ((m = itemRegex.exec(cleanVal)) !== null) {
            items.push(m[1].toLowerCase());
        }
        
        if (items.length > 0) {
            if (activeParent && activeSubParent) {
                const prefix = `${activeParent}(${activeSubParent})`;
                items.forEach(item => {
                    clauseSet.add(`${prefix}(${item})`);
                    clauseSet.add(`${prefix}${item}`);
                });
            } else if (activeParent) {
                items.forEach(item => {
                    clauseSet.add(`${activeParent}(${item})`);
                    clauseSet.add(`${activeParent}${item}`);
                });
            }
        }
    }
    
    return Array.from(clauseSet);
}

async function run() {
    const snap = await db.collection("chunks").get();
    console.log(`Total chunks to process: ${snap.size}`);
    
    let updated = 0, skipped = 0;
    const BATCH_SIZE = 400;
    let batch = db.batch();
    let batchCount = 0;
    
    for (const doc of snap.docs) {
        const data = doc.data();
        const text = data.text || '';
        const pageNum = data.pageNumber;
        
        const newClauses = extractPageClauses(text, pageNum);
        const oldClauses = data.clauses || [];
        
        const oldSet = new Set(oldClauses);
        const newSet = new Set(newClauses);
        const hasChange = newClauses.some(c => !oldSet.has(c)) || oldClauses.some(c => !newSet.has(c));
        
        if (!hasChange) { skipped++; continue; }
        
        batch.update(doc.ref, { clauses: newClauses });
        batchCount++;
        updated++;
        
        if (batchCount >= BATCH_SIZE) {
            await batch.commit();
            console.log(`Committed batch of ${batchCount}`);
            batch = db.batch();
            batchCount = 0;
        }
    }
    
    if (batchCount > 0) {
        await batch.commit();
        console.log(`Committed final batch of ${batchCount}`);
    }
    
    console.log(`\nRe-indexing finished. Updated: ${updated}, Skipped: ${skipped}`);
}

run().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
