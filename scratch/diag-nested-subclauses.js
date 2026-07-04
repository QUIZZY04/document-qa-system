const admin = require('firebase-admin');
const path = require('path');
const serviceAccount = require(path.join(__dirname, '..', 'service-account.json'));
if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

async function run() {
    const snap = await db.collection("chunks").get();
    console.log(`Total chunks: ${snap.size}\n`);

    // 1. Find all chunks where raw text contains 1(c) and roman numerals
    console.log("=== Lines containing 1(c) with sub-items ===");
    snap.forEach(doc => {
        const data = doc.data();
        const text = data.text || '';
        for (const line of text.split('\n')) {
            if (/\[SI:\s*1\s*\(c\)/i.test(line) || /\[SI:\s*1c/i.test(line)) {
                console.log(`\nDoc: ${data.docName} | Page: ${data.pageNumber}`);
                console.log("  LINE:", line.substring(0, 400));
            }
        }
    });

    // 2. Show all SI patterns with roman numerals
    console.log("\n=== All SI values containing roman numerals (i, ii, iii, iv) ===");
    snap.forEach(doc => {
        const data = doc.data();
        const text = data.text || '';
        for (const line of text.split('\n')) {
            if (/\[SI:[^\]]*\(i{1,4}v?\)\s*\]/i.test(line) || /\[SI:[^\]]*\bi{1,4}v?\b/i.test(line)) {
                console.log(`Doc: ${data.docName} | Page: ${data.pageNumber}`);
                console.log("  LINE:", line.substring(0, 400));
            }
        }
    });

    // 3. Show all clauses currently stored for clause 1
    console.log("\n=== Current clauses array for chunks with clause '1' ===");
    let shown = 0;
    snap.forEach(doc => {
        const data = doc.data();
        if ((data.clauses || []).includes('1') && shown < 5) {
            console.log(`Doc: ${data.docName} | Page: ${data.pageNumber} | clauses:`, data.clauses.slice(0, 20).join(', '));
            shown++;
        }
    });
}

run().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
