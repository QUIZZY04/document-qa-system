const admin = require('firebase-admin');
const path = require('path');
const serviceAccount = require(path.join(__dirname, '..', 'service-account.json'));
if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();

async function run() {
    const snap = await db.collection("chunks").get();
    // Check what raw SI numbers exist for 14, 16, 18, 26
    for (const missing of ['14', '16', '18', '26']) {
        let found = false;
        snap.forEach(doc => {
            const text = doc.data().text || '';
            const re = new RegExp(`\\[SI:\\s*${missing}[.\\s\\]|]`, 'i');
            if (re.test(text)) {
                found = true;
                const lines = text.split('\n').filter(l => re.test(l));
                console.log(`\n[SI: ${missing}] found in Doc: ${doc.data().docName}, Page: ${doc.data().pageNumber}`);
                lines.forEach(l => console.log('  ', l.substring(0, 200)));
            }
        });
        if (!found) console.log(`\n[SI: ${missing}] NOT found in any chunk — this clause may not exist in the DOP document.`);
    }
}
run().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
