require('dotenv').config();
const admin = require('firebase-admin');
const pdf = require('pdf-parse');

const serviceAccount = require('./service-account.json');
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    storageBucket: "robotic-af198.firebasestorage.app"
});
const db = admin.firestore();
const bucket = admin.storage().bucket();

async function run() {
    const snap = await db.collection("documents").where("name", "==", "DOP Sec II Revised march 2023.pdf").get();
    const docId = snap.docs[0].id;
    const fileRef = bucket.file(`documents/${docId}/DOP Sec II Revised march 2023.pdf`);
    const [buffer] = await fileRef.download();
    
    // Print header rows from every page to discover column X-positions
    await pdf(buffer, {
        pagerender: function(pageData) {
            const pageIndex = pageData.pageIndex; // 0-based
            return pageData.getTextContent().then(tc => {
                const items = tc.items;
                if (items.length === 0) return "";

                // Group into y-lines
                const yTol = 3;
                let lines = [];
                for (let item of items) {
                    const text = item.str.trim();
                    if (!text) continue;
                    const x = item.transform[4];
                    const y = item.transform[5];
                    let fl = lines.find(l => Math.abs(l.y - y) <= yTol);
                    if (fl) fl.items.push({ text, x });
                    else lines.push({ y, items: [{ text, x }] });
                }
                lines.sort((a, b) => b.y - a.y);

                // Find header row: line that contains ED/E.D. + G.M./GM + AGM/A.G.M. etc.
                for (let line of lines) {
                    const joined = line.items.map(i => i.text).join(' ');
                    const hasED = /\bE\.?D\.?\b/.test(joined);
                    const hasGM = /\bG\.?M\.?\b/.test(joined);
                    const hasAGM = /\bA\.?G\.?M\.?\b/.test(joined);
                    if (hasED && hasGM && hasAGM) {
                        const sorted = line.items.sort((a, b) => a.x - b.x);
                        console.log(`\n=== Page ${pageIndex + 1} HEADER ROW ===`);
                        sorted.forEach(it => console.log(`  "${it.text}" at X=${it.x.toFixed(1)}`));
                    }
                }
                return "";
            });
        }
    });
}

run().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
