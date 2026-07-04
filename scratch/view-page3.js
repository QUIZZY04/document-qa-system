const admin = require('firebase-admin');
const path = require('path');
const serviceAccount = require(path.join(__dirname, '..', 'service-account.json'));
if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

async function run() {
    const snap = await db.collection("chunks").where("pageNumber", "==", 3).get();
    console.log(`Chunks on page 3: ${snap.size}`);
    snap.forEach(doc => {
        console.log(`--- Chunk ID: ${doc.id} ---`);
        console.log(doc.data().text);
    });
}

run().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
