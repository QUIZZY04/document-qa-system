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
    const question = "who is approving authority under DOP clause 4.3 for Rs 2100000";
    console.log(`Query: "${question}"`);
    
    const queryEmbeddingResponse = await openai.embeddings.create({
        model: "text-embedding-3-small",
        input: question
    });
    const queryEmbedding = queryEmbeddingResponse.data[0].embedding;
    
    const query = db.collection("chunks").findNearest({
        vectorField: 'embedding',
        queryVector: queryEmbedding,
        limit: 10,
        distanceMeasure: 'COSINE'
    });

    const chunksSnap = await query.get();
    console.log(`Retrieved ${chunksSnap.size} chunks.`);
    
    let index = 0;
    chunksSnap.forEach((doc) => {
        const chunk = doc.data();
        const vec = chunk.embedding ? chunk.embedding.toArray() : [];
        const sim = vec.length > 0 ? cosineSimilarity(queryEmbedding, vec) : 0;
        console.log(`\n--- Position ${index + 1} (Page ${chunk.pageNumber}, Similarity: ${sim.toFixed(4)}) ---`);
        console.log(chunk.text.substring(0, 400));
        index++;
    });
}

run().then(() => process.exit(0)).catch(err => {
    console.error(err);
    process.exit(1);
});
