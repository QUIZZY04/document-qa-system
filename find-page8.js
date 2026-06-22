require('dotenv').config();
const admin = require('firebase-admin');
const { OpenAI } = require('openai');

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

const serviceAccount = require('./service-account.json');
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

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
    const question = "who is approving authority under dop clause 4.2 for rs 100000";
    const queryEmbeddingResponse = await openai.embeddings.create({
        model: "text-embedding-3-small",
        input: question
    });
    const queryEmbedding = queryEmbeddingResponse.data[0].embedding;
    
    console.log("Fetching all chunks for pageNumber = 8...");
    const snap = await db.collection("chunks").where("pageNumber", "==", 8).get();
    console.log(`Found ${snap.size} chunks for Page 8.`);
    
    snap.forEach((doc, index) => {
        const chunk = doc.data();
        const vec = chunk.embedding ? chunk.embedding.toArray() : [];
        const sim = vec.length > 0 ? cosineSimilarity(queryEmbedding, vec) : 0;
        console.log(`\n--- Page 8 Chunk ${index + 1} (Similarity: ${sim.toFixed(4)}) ---`);
        console.log(`Text preview:\n"${chunk.text}"`);
    });
}

run().then(() => process.exit(0)).catch(err => {
    console.error(err);
    process.exit(1);
});
