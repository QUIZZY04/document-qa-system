const admin = require('firebase-admin');
const path = require('path');
const serviceAccount = require('../service-account.json');

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

async function run() {
    console.log("Searching Firestore chunks for '9A' or 'clause 9'...");
    const snap = await db.collection("chunks").get();
    
    let matches = [];
    snap.forEach(doc => {
        const data = doc.data();
        const text = data.text || "";
        const clauses = data.clauses || [];
        
                const hasMatch = clauses.includes("9") || text.toLowerCase().includes("[si: 9");
        
        if (hasMatch) {
            matches.push({
                id: doc.id,
                page: data.pageNumber,
                clauses: clauses,
                preview: text
            });
        }
    });
    
    console.log(`Found ${matches.length} matching chunks:`);
    matches.forEach((m, idx) => {
        console.log(`\n[${idx + 1}] ID: ${m.id} | Page: ${m.page}`);
        console.log(`    Clauses:`, m.clauses);
        console.log(`    Preview:\n${m.preview}`);
    });
}

run().then(() => process.exit(0)).catch(err => {
    console.error(err);
    process.exit(1);
});
