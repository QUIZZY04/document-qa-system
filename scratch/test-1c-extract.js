const admin = require('firebase-admin');
const path = require('path');
const serviceAccount = require(path.join(__dirname, '..', 'service-account.json'));
if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

function extractClauseRow(chunks, clauseNumber) {
    const siRe = new RegExp(`\\[SI:\\s*${clauseNumber.replace('.', '\\.')}[\\s\\.\\]|]`, 'i');
    for (const chunk of chunks) {
        for (const line of (chunk.text || '').split('\n')) {
            if (!siRe.test(line)) continue;
            const extract = (key) => {
                const m = line.match(new RegExp(`\\[${key}:\\s*([^\\]]+)\\]`, 'i'));
                return m ? m[1].trim() : null;
            };
            const row = { 
                Nature: extract('Nature of Power'), 
                ED: extract('ED'),
                GM: extract('GM'), 
                AGM: extract('AGM'), 
                DGM: extract('DGM'), 
                SM: extract('SM') 
            };
            if (row.ED || row.GM || row.AGM || row.DGM || row.SM) return row;
        }
    }
    return null;
}

async function run() {
    const snap = await db.collection("chunks").where("pageNumber", "==", 3).get();
    const chunks = [];
    snap.forEach(doc => chunks.push(doc.data()));
    
    // We try to extract clause "c" from page 3 chunks (since the database stores SI as `c) All townshin i) ii)`)
    console.log("=== Extracting row for SI 'c' ===");
    const row = extractClauseRow(chunks, "c");
    console.log(JSON.stringify(row, null, 2));
}

run().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
