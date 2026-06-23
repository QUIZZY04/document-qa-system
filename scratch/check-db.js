const admin = require('firebase-admin');
const path = require('path');
const serviceAccount = require('../service-account.json');

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

async function checkDocs() {
    console.log("Fetching documents from Firestore...");
    const snap = await db.collection("documents").get();
    if (snap.empty) {
        console.log("No documents found in Firestore 'documents' collection.");
        return;
    }
    
    console.log(`Found ${snap.size} document(s):`);
    snap.forEach(doc => {
        const data = doc.data();
        console.log(`- ID: ${doc.id}`);
        console.log(`  Name: ${data.name}`);
        console.log(`  Status: ${data.status}`);
        console.log(`  Pages: ${data.pages}`);
        console.log(`  Upload Date: ${data.uploadDate ? data.uploadDate.toDate() : '-'}`);
        console.log("-----------------------------------------");
    });
}

checkDocs().then(() => process.exit(0)).catch(err => {
    console.error(err);
    process.exit(1);
});
