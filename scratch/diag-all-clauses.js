const admin = require('firebase-admin');
const path = require('path');
const serviceAccount = require(path.join(__dirname, '..', 'service-account.json'));
if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();

async function run() {
    const snap = await db.collection("chunks").get();
    console.log(`Total chunks: ${snap.size}\n`);

    // Collect all clause tags stored per chunk
    const allClauses = new Set();
    const clauseToChunkCount = {};
    
    snap.forEach(doc => {
        const data = doc.data();
        const clauses = data.clauses || [];
        clauses.forEach(c => {
            allClauses.add(c);
            clauseToChunkCount[c] = (clauseToChunkCount[c] || 0) + 1;
        });
    });

    // Show numeric top-level clauses
    const topLevel = [...allClauses]
        .filter(c => /^\d+$/.test(c))
        .map(Number).sort((a,b) => a-b);
    console.log("=== Top-level clause numbers stored in DB ===");
    console.log(topLevel.join(', '));

    // Show all clauses that have sub-clauses (letters)
    const withLetters = [...allClauses]
        .filter(c => /^\d+.*[a-z]/i.test(c))
        .sort();
    console.log("\n=== Clauses with letter sub-clauses stored in DB ===");
    console.log(withLetters.join(', '));

    // Show all decimal sub-clauses
    const decimal = [...allClauses]
        .filter(c => /^\d+\.\d+/.test(c))
        .sort((a,b) => {
            const [am, an] = a.split('.');
            const [bm, bn] = b.split('.');
            return (+am - +bm) || (+an - +bn);
        });
    console.log("\n=== Decimal sub-clauses stored in DB ===");
    console.log(decimal.join(', '));

    // What top-level clauses are MISSING as standalone entries?
    const topSet = new Set(topLevel.map(String));
    console.log("\n=== Checking which SI numbers from raw text are not in clauses array ===");
    // Re-scan raw text for SI: numbers
    const siFromText = new Set();
    snap.forEach(doc => {
        const text = doc.data().text || '';
        for (const m of text.matchAll(/\[SI:\s*(\d+)/g)) {
            siFromText.add(m[1]);
        }
    });
    const textNums = [...siFromText].map(Number).sort((a,b)=>a-b);
    const missingFromClauses = textNums.filter(n => !topSet.has(String(n)));
    console.log("SI numbers found in raw text:", textNums.join(', '));
    console.log("Missing from clauses array:", missingFromClauses.length ? missingFromClauses.join(', ') : "(none)");
}

run().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
