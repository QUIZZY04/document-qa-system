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
    console.log("Listing all clause/SI numbers in database chunks...");
    const chunksSnap = await db.collection("chunks").get();
    
    let clauses = new Set();
    const regex = /\[SI:\s*([^\]]+)\]/gi;
    
    chunksSnap.forEach(doc => {
        const data = doc.data();
        const text = data.text || "";
        let match;
        // reset index for global regex
        regex.lastIndex = 0;
        while ((match = regex.exec(text)) !== null) {
            clauses.add(match[1].trim());
        }
    });

    console.log("Found clauses in database:");
    const sortedClauses = Array.from(clauses).sort();
    console.log(sortedClauses.join(", "));
}

run().then(() => process.exit(0)).catch(err => {
    console.error(err);
    process.exit(1);
});
