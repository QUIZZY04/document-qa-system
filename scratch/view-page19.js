const admin = require('firebase-admin');
const path = require('path');

const serviceAccount = require(path.join(__dirname, '..', 'service-account.json'));

if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
}

const db = admin.firestore();

async function run() {
    console.log("Fetching Page 19 chunks...");
    const chunksSnap = await db.collection("chunks")
        .where("docName", "==", "DOP Sec II Revised march 2023.pdf")
        .where("pageNumber", "==", 19)
        .get();
        
    console.log(`Found ${chunksSnap.size} chunks for page 19:`);
    chunksSnap.forEach((doc, idx) => {
        console.log(`\n--- Chunk ${idx + 1} ---`);
        console.log(doc.data().text);
    });
}

run().then(() => process.exit(0)).catch(err => {
    console.error(err);
    process.exit(1);
});
