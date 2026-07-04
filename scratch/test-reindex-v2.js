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
        
        // 3. Sub-items (roman or letters)
        // Clean SI string for finding standalone item markers like i) or ii) or a)
        const cleanVal = val.replace(/^([a-z])\)/i, ''); // strip leading "c)" prefix
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
    
    // Group chunks by page number
    const pageChunks = {};
    snap.forEach(doc => {
        const data = doc.data();
        const pg = data.pageNumber;
        if (!pageChunks[pg]) pageChunks[pg] = [];
        pageChunks[pg].push({ id: doc.id, text: data.text || '' });
    });

    console.log("=== Testing Clause Generation for Page 3 ===");
    if (pageChunks[3]) {
        pageChunks[3].forEach(chunk => {
            const tags = extractPageClauses(chunk.text, 3);
            console.log(`\nChunk ID: ${chunk.id}`);
            console.log(`Tags:`, tags.filter(t => t.includes('1(c)')).join(', '));
        });
    }

    console.log("\n=== Testing Clause Generation for Page 24 ===");
    if (pageChunks[24]) {
        pageChunks[24].forEach(chunk => {
            const tags = extractPageClauses(chunk.text, 24);
            console.log(`\nChunk ID: ${chunk.id}`);
            console.log(`Tags:`, tags.filter(t => t.includes('22')).join(', '));
        });
    }
}

run().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
