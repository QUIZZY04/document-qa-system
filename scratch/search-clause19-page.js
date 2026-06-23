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
    console.log("Searching for the chunk containing '19. Authorising'...");
    const chunksSnap = await db.collection("chunks").get();
    
    chunksSnap.forEach(doc => {
        const data = doc.data();
        const text = data.text || "";
        if (text.includes("19. Authorising") || text.toLowerCase().includes("clause 19") || text.includes("SI: 19")) {
            console.log(`\nFound in Document: "${data.docName}", Page: ${data.pageNumber}`);
            console.log(`Text: "${text}"`);
        }
    });
}

run().then(() => process.exit(0)).catch(err => {
    console.error(err);
    process.exit(1);
});
