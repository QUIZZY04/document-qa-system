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
    console.log("Searching Firestore chunks for 'clause 19' or '19'...");
    const chunksSnap = await db.collection("chunks").get();
    console.log(`Total chunks in Firestore: ${chunksSnap.size}`);
    
    let matches = [];
    chunksSnap.forEach(doc => {
        const data = doc.data();
        const text = data.text || "";
        if (text.toLowerCase().includes("clause 19") || text.toLowerCase().includes(" 19 ") || text.toLowerCase().includes("[si: 19") || text.toLowerCase().includes("19.")) {
            matches.push({
                docName: data.docName,
                pageNumber: data.pageNumber,
                textSnippet: text.substring(0, 300)
            });
        }
    });

    console.log(`Found ${matches.length} chunks containing references to 19:`);
    matches.forEach((m, idx) => {
        console.log(`\nMatch ${idx + 1}: Document: "${m.docName}", Page: ${m.pageNumber}`);
        console.log(`Snippet: "${m.textSnippet.replace(/\n/g, ' ')}"`);
    });
}

run().then(() => process.exit(0)).catch(err => {
    console.error(err);
    process.exit(1);
});
