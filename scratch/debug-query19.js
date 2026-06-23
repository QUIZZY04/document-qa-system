const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const admin = require('firebase-admin');
const { OpenAI } = require('openai');

const serviceAccount = require(path.join(__dirname, '..', 'service-account.json'));

if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
}

const db = admin.firestore();
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

function cosineSimilarity(vecA, vecB) {
    let dotProduct = 0.0;
    let normA = 0.0;
    let normB = 0.0;
    for (let i = 0; i < vecA.length; i++) {
        dotProduct += vecA[i] * vecB[i];
        normA += vecA[i] * vecA[i];
        normB += vecB[i] * vecB[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

async function run() {
    const question = "clause 19";
    console.log(`Running vector search for query: "${question}"...`);
    
    const queryEmbeddingResponse = await openai.embeddings.create({
        model: "text-embedding-3-small",
        input: question
    });
    const queryEmbedding = queryEmbeddingResponse.data[0].embedding;

    // Vector query
    const query = db.collection("chunks").findNearest({
        vectorField: 'embedding',
        queryVector: queryEmbedding,
        limit: 20,
        distanceMeasure: 'COSINE'
    });

    const chunksSnap = await query.get();
    let results = [];
    chunksSnap.forEach(doc => {
        const data = doc.data();
        const vec = data.embedding ? data.embedding.toArray() : [];
        const similarity = vec.length > 0 ? cosineSimilarity(queryEmbedding, vec) : 0;
        
        results.push({
            id: doc.id,
            docName: data.docName,
            pageNumber: data.pageNumber,
            text: data.text,
            similarity: similarity
        });
    });

    results.sort((a, b) => b.similarity - a.similarity);
    
    console.log(`Top 10 retrieved chunks for "${question}":`);
    results.slice(0, 10).forEach((r, idx) => {
        const has19 = r.text.includes("19.") || r.text.toLowerCase().includes("clause 19") || r.text.includes("SI: 19");
        console.log(`\nRank ${idx + 1} (Score: ${r.similarity.toFixed(4)}) - Page ${r.pageNumber} [Has Clause 19: ${has19}]`);
        console.log(`Snippet: "${r.text.substring(0, 200).replace(/\n/g, ' ')}"`);
    });
}

run().then(() => process.exit(0)).catch(err => {
    console.error(err);
    process.exit(1);
});
