const admin = require('firebase-admin');
const pdf = require('pdf-parse');
const path = require('path');

const serviceAccount = require('./service-account.json');
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    storageBucket: "robotic-af198.firebasestorage.app"
});

const db = admin.firestore();
const bucket = admin.storage().bucket();

async function parsePdfPages(buffer) {
    let pagesText = [];
    function render_page(pageData) {
        let render_options = {
            normalizeWhitespace: true,
            disableCombineTextItems: false
        };
        return pageData.getTextContent(render_options)
            .then(function(textContent) {
                let lastY, text = '';
                for (let item of textContent.items) {
                    if (lastY == item.transform[5] || !lastY) {
                        text += item.str;
                    } else {
                        text += '\n' + item.str;
                    }
                    lastY = item.transform[5];
                }
                pagesText.push(text);
                return text;
            });
    }
    let options = { pagerender: render_page };
    await pdf(buffer, options);
    return pagesText;
}

async function run() {
    const snap = await db.collection("documents").where("name", "==", "DOP Sec II Revised march 2023.pdf").get();
    const docId = snap.docs[0].id;
    const storagePath = `documents/${docId}/DOP Sec II Revised march 2023.pdf`;
    const fileRef = bucket.file(storagePath);
    const [buffer] = await fileRef.download();
    const pages = await parsePdfPages(buffer);
    
    console.log("=== Page 7 Text ===");
    console.log(pages[6]);
    console.log("\n=== Page 8 Text ===");
    console.log(pages[7]);
}

run().then(() => process.exit(0)).catch(err => {
    console.error(err);
    process.exit(1);
});
