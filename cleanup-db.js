const admin = require('firebase-admin');
const path = require('path');

const serviceAccount = require('./service-account.json');
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

async function clean() {
    console.log("Fetching all documents in 'chunks'...");
    const chunksSnap = await db.collection("chunks").get();
    console.log(`Found ${chunksSnap.size} chunks to delete.`);
    
    if (chunksSnap.size > 0) {
        const batchSize = 100;
        let batch = db.batch();
        let count = 0;
        
        for (const doc of chunksSnap.docs) {
            batch.delete(doc.ref);
            count++;
            if (count % batchSize === 0) {
                await batch.commit();
                console.log(`Deleted ${count} chunks...`);
                batch = db.batch();
            }
        }
        if (count % batchSize !== 0) {
            await batch.commit();
            console.log(`Deleted remaining chunks. Total deleted: ${count}`);
        }
    }
    
    console.log("Setting all document statuses to 'Processing' to re-index them...");
    const docsSnap = await db.collection("documents").get();
    for (const doc of docsSnap.docs) {
        await doc.ref.update({ status: 'Processing' });
        console.log(`Updated document ${doc.data().name} to 'Processing'`);
    }
    console.log("Cleanup complete!");
}

clean().then(() => process.exit(0)).catch(err => {
    console.error(err);
    process.exit(1);
});
