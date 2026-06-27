const admin = require('firebase-admin');
const path = require('path');
const serviceAccount = require('../service-account.json');

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

async function run() {
    const snap = await db.collection("documents").where("name", "==", "DOP Sec II Revised march 2023.pdf").get();
    if (snap.empty) {
        console.log("Document not found.");
        return;
    }
    const docRef = snap.docs[0].ref;
    await docRef.update({ status: "Processing" });
    console.log("Status updated to 'Processing'. Re-indexing triggered successfully!");
}

run().then(() => process.exit(0)).catch(err => {
    console.error(err);
    process.exit(1);
});
