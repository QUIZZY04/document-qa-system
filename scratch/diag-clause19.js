const admin = require('firebase-admin');
const path = require('path');
const serviceAccount = require(path.join(__dirname, '..', 'service-account.json'));
if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();

async function run() {
    const snap = await db.collection("chunks").get();

    // Show all lines containing [SI: 19 in any form
    console.log("=== All lines matching SI: 19 (any form) ===");
    snap.forEach(doc => {
        const data = doc.data();
        const text = data.text || '';
        for (const line of text.split('\n')) {
            if (/\[SI:\s*19/.test(line)) {
                console.log(`\nDoc: ${data.docName} | Page: ${data.pageNumber}`);
                console.log("LINE:", line.substring(0, 350));
            }
        }
    });

    // Also show what the server's extractClauseRow regex would match for "19"
    const clauseNumber = "19";
    const siRe = new RegExp(`\\[SI:\\s*${clauseNumber.replace('.', '\\.')}[\\s\\]|]`, 'i');
    console.log(`\n=== Testing server regex for clauseNumber="19": ${siRe} ===`);
    let found = false;
    snap.forEach(doc => {
        const data = doc.data();
        const text = data.text || '';
        for (const line of text.split('\n')) {
            if (siRe.test(line)) {
                console.log("  MATCH:", line.substring(0, 300));
                found = true;
            }
        }
    });
    if (!found) console.log("  (no match found)");
}

run().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
