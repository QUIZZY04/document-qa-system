const admin = require('firebase-admin');
const path = require('path');
const serviceAccount = require(path.join(__dirname, '..', 'service-account.json'));
if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

async function run() {
    const snap = await db.collection("chunks").get();
    
    // Find all chunks where SI starts with a letter without a number
    console.log("=== Chunks with SI starting with a letter or symbol ===");
    const results = [];
    snap.forEach(doc => {
        const text = doc.data().text || '';
        const lines = text.split('\n');
        for (const line of lines) {
            const match = line.match(/\[SI:\s*([^\d\]][^\]]*?)\]/i);
            if (match) {
                results.push({
                    page: doc.data().pageNumber,
                    si: match[1].trim(),
                    line: line.substring(0, 200)
                });
            }
        }
    });

    console.log(`Found ${results.length} lines:`);
    results.slice(0, 100).forEach((r, idx) => {
        console.log(`Page ${r.page} | SI: "${r.si}" | Line: ${r.line}`);
    });
}

run().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
