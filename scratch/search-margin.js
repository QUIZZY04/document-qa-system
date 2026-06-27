const admin = require('firebase-admin');
const path = require('path');
const serviceAccount = require('../service-account.json');

if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
}

const db = admin.firestore();

async function run() {
    console.log("Searching chunks for 'margin' or 'preference'...");
    const snap = await db.collection("chunks").get();
    let found = 0;
    snap.forEach(doc => {
        const text = doc.data().text || "";
        if (text.toLowerCase().includes("margin") || text.toLowerCase().includes("preference")) {
            console.log(`\nFound in Document: "${doc.data().docName}", Page: ${doc.data().pageNumber}`);
            console.log(`Text: "${text.substring(0, 300)}..."`);
            found++;
        }
    });
    console.log(`Total occurrences found: ${found}`);
}

run().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
