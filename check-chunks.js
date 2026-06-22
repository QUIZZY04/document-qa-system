const admin = require('firebase-admin');
const path = require('path');

const serviceAccount = require('./service-account.json');

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

async function run() {
    console.log("Checking total chunks count...");
    const chunksSnap = await db.collection("chunks").get();
    console.log(`Total chunks: ${chunksSnap.size}`);
    
    if (chunksSnap.size > 0) {
        console.log("Printing first 5 chunks metadata & text preview:");
        let idx = 0;
        chunksSnap.forEach(doc => {
            if (idx < 5) {
                const data = doc.data();
                console.log(`\nChunk ${idx + 1}:`);
                console.log(`  Doc Name: ${data.docName}`);
                console.log(`  Page Number: ${data.pageNumber}`);
                console.log(`  Text Length: ${data.text ? data.text.length : 0}`);
                console.log(`  Text Preview: "${data.text ? data.text.substring(0, 200).replace(/\n/g, ' ') : ''}"`);
                idx++;
            }
        });
    }

    console.log("\nSearching for chunks matching 'clause 4.2' or '4.2' or 'approving authority' in local text search...");
    let found = [];
    chunksSnap.forEach(doc => {
        const data = doc.data();
        const text = data.text || "";
        if (text.toLowerCase().includes("clause 4.2") || text.toLowerCase().includes("4.2") || text.toLowerCase().includes("approving authority")) {
            found.push({
                pageNumber: data.pageNumber,
                textSnippet: text.substring(0, 300)
            });
        }
    });

    console.log(`Found ${found.length} matching chunks in client-side text check:`);
    found.slice(0, 10).forEach((f, idx) => {
        console.log(`- Match ${idx+1}: Page ${f.pageNumber} -> "${f.textSnippet.replace(/\n/g, ' ')}"`);
    });
}

run().then(() => process.exit(0)).catch(err => {
    console.error(err);
    process.exit(1);
});
