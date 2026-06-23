const admin = require('firebase-admin');
const serviceAccount = require('./service-account.json');
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

async function run() {
    for (const page of [6, 7, 8]) {
        const snap = await db.collection("chunks").where("pageNumber", "==", page).get();
        console.log(`\n${'='.repeat(60)}`);
        console.log(`PAGE ${page} — ${snap.size} chunk(s)`);
        snap.forEach((doc, idx) => {
            const data = doc.data();
            console.log(`\n--- Chunk ${idx+1} ---`);
            console.log(data.text);
        });
    }
}

run().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
