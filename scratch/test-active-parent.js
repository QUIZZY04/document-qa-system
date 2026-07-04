const admin = require('firebase-admin');
const path = require('path');
const serviceAccount = require(path.join(__dirname, '..', 'service-account.json'));
if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

function findActiveParentClause(pageText) {
    const m = pageText.match(/\[SI:\s*(\d+)(?:\.\s*|\s+Works|\s+Procurement|\s+Modification|\s+Calling|\s+Award|\s+Administrative)/i);
    if (m) return m[1];
    
    const m2 = pageText.match(/\[SI:\s*(\d+)/i);
    if (m2) return m2[1];
    
    return null;
}

async function run() {
    const snap = await db.collection("chunks").get();
    
    // Group chunks by page number
    const pageChunks = {};
    snap.forEach(doc => {
        const data = doc.data();
        const pg = data.pageNumber;
        if (!pageChunks[pg]) pageChunks[pg] = [];
        pageChunks[pg].push(data.text || '');
    });

    console.log("=== Active Parent Clause per Page ===");
    const sortedPages = Object.keys(pageChunks).map(Number).sort((a,b)=>a-b);
    sortedPages.forEach(pg => {
        // Combine all chunks of the page to get the full page text
        const pageText = pageChunks[pg].join('\n');
        const parent = findActiveParentClause(pageText);
        console.log(`Page ${pg} → Active Parent: ${parent || 'NOT FOUND'}`);
    });
}

run().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
