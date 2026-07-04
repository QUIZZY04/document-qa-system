const admin = require('firebase-admin');
const path = require('path');
const serviceAccount = require(path.join(__dirname, '..', 'service-account.json'));
if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

async function run() {
    const snap = await db.collection("chunks").get();
    snap.forEach(doc => {
        const text = doc.data().text || '';
        if (text.includes("1 (c)") || text.includes("1(c)") || text.includes("townshin")) {
            console.log(`Doc: ${doc.data().docName} | Page: ${doc.data().pageNumber}`);
            console.log(text);
            console.log("======================================");
        }
    });
}

run().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
