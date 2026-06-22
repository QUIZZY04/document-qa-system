const admin = require('firebase-admin');
const pdf = require('pdf-parse');
const path = require('path');

const serviceAccount = require(path.join(__dirname, 'service-account.json'));

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    storageBucket: "robotic-af198.firebasestorage.app"
});

const db = admin.firestore();
const bucket = admin.storage().bucket();

// Our custom pager function
async function parsePdfPagesCustom(buffer) {
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
    let options = { pager: render_page };
    await pdf(buffer, options);
    return pagesText;
}

async function runTest() {
    // Get document by name
    const snap = await db.collection("documents").where("name", "==", "DOP Sec II Revised march 2023.pdf").get();
    if (snap.empty) {
        console.log("Document record not found in Firestore.");
        return;
    }
    
    const docId = snap.docs[0].id;
    const storagePath = `documents/${docId}/DOP Sec II Revised march 2023.pdf`;
    console.log(`Downloading from storage path: ${storagePath}`);
    
    const fileRef = bucket.file(storagePath);
    const [exists] = await fileRef.exists();
    if (!exists) {
        console.log("File does not exist in storage bucket!");
        return;
    }
    
    const [buffer] = await fileRef.download();
    console.log(`File downloaded. Size: ${buffer.length} bytes.`);
    
    // Test 1: Custom page parser
    console.log("\n--- Testing Custom Page Parser ---");
    try {
        const pagesCustom = await parsePdfPagesCustom(buffer);
        console.log(`Custom parser extracted: ${pagesCustom.length} pages.`);
        if (pagesCustom.length > 0) {
            console.log(`First page preview (first 100 chars): "${pagesCustom[0].substring(0, 100)}"`);
        }
    } catch (e) {
        console.error("Custom parser error:", e);
    }
    
    // Test 2: Default pdf-parse
    console.log("\n--- Testing Default pdf-parse ---");
    try {
        const defaultData = await pdf(buffer);
        console.log(`Default parser reported pages: ${defaultData.numpages}`);
        console.log(`Default parser text length: ${defaultData.text.length} characters.`);
        if (defaultData.text.length > 0) {
            console.log(`First 200 characters of default text:\n"${defaultData.text.substring(0, 200)}"`);
        }
    } catch (e) {
        console.error("Default parser error:", e);
    }
}

runTest().then(() => process.exit(0)).catch(err => {
    console.error(err);
    process.exit(1);
});
