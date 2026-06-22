require('dotenv').config();
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const { FieldValue } = require('firebase-admin/firestore');
const { OpenAI } = require('openai');
const pdf = require('pdf-parse');
const fs = require('fs');
const path = require('path');

// Initialize Express App
const app = express();
app.use(cors());
app.use(express.json());

// Initialize OpenAI client
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

// Initialize Firebase Admin SDK
const serviceAccountPath = path.join(__dirname, 'service-account.json');
if (!fs.existsSync(serviceAccountPath)) {
    console.error("CRITICAL ERROR: 'service-account.json' not found in the root directory!");
    console.error("Please follow the instructions to download your service account key and place it here.");
    process.exit(1);
}

const serviceAccount = require(serviceAccountPath);
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    storageBucket: "robotic-af198.firebasestorage.app" // Match your storage bucket config
});

const db = admin.firestore();
const bucket = admin.storage().bucket();

// Helper to calculate cosine similarity
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

// Custom page-by-page PDF parser using pdf-parse
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

    let options = {
        pagerender: render_page
    };
    
    await pdf(buffer, options);
    return pagesText;
}

// Ingestion Listener: Listen to documents with "Processing" status
console.log("Starting real-time PDF Ingestion Listener...");
db.collection("documents").where("status", "==", "Processing")
    .onSnapshot((snapshot) => {
        snapshot.forEach(async (docSnap) => {
            const docId = docSnap.id;
            const docData = docSnap.data();
            const docRef = db.collection("documents").doc(docId);
            
            console.log(`Processing document: "${docData.name}" (${docId})...`);
            
            try {
                // 1. Download file from Firebase Storage
                // Path matches: documents/{docId}/{filename}
                const storagePath = `documents/${docId}/${docData.name}`;
                const fileRef = bucket.file(storagePath);
                
                const [exists] = await fileRef.exists();
                if (!exists) {
                    console.log(`File not found at: ${storagePath}`);
                    try {
                        const [files] = await bucket.getFiles({ prefix: `documents/${docId}/` });
                        console.log(`Files under documents/${docId}/:`, files.map(f => f.name));
                        const [allFiles] = await bucket.getFiles({ maxResults: 10 });
                        console.log("First 10 files in bucket:", allFiles.map(f => f.name));
                    } catch (bucketErr) {
                        console.error("Failed to list bucket files:", bucketErr);
                    }
                    throw new Error(`File not found in storage at path: ${storagePath}`);
                }
                
                const [fileBuffer] = await fileRef.download();
                console.log(`Downloaded file size: ${fileBuffer.length} bytes.`);
                console.log(`File signature (first 10 chars): "${fileBuffer.slice(0, 10).toString()}"`);
                
                // 2. Parse PDF pages
                const pagesText = await parsePdfPages(fileBuffer);
                console.log(`Parsed ${pagesText.length} pages from "${docData.name}".`);
                
                // Update pages count in parent document
                await docRef.update({ pages: pagesText.length });
                
                // 3. Clear any existing chunks for this document to avoid duplication
                const oldChunksSnap = await db.collection("chunks").where("docId", "==", docId).get();
                if (!oldChunksSnap.empty) {
                    const batch = db.batch();
                    oldChunksSnap.forEach(chunkDoc => batch.delete(chunkDoc.ref));
                    await batch.commit();
                }
                
                // 4. Generate embeddings and save chunks
                for (let i = 0; i < pagesText.length; i++) {
                    const pageText = pagesText[i].trim();
                    const pageNumber = i + 1;
                    
                    if (pageText.length < 10) {
                        console.log(`Skipping empty or tiny page ${pageNumber}.`);
                        continue;
                    }
                    
                    // Simple page segmentation: split long pages if > 1500 chars
                    const maxChunkLength = 1500;
                    let chunks = [];
                    if (pageText.length > maxChunkLength) {
                        // Split into two overlapping halves or chunks
                        let startIndex = 0;
                        while (startIndex < pageText.length) {
                            const chunkText = pageText.substring(startIndex, startIndex + maxChunkLength);
                            chunks.push(chunkText);
                            startIndex += 1000; // 500 characters overlap
                        }
                    } else {
                        chunks.push(pageText);
                    }
                    
                    for (let j = 0; j < chunks.length; j++) {
                        const chunkText = chunks[j];
                        
                        // Call OpenAI Embeddings API
                        const embeddingResponse = await openai.embeddings.create({
                            model: "text-embedding-3-small",
                            input: chunkText
                        });
                        
                        const embedding = embeddingResponse.data[0].embedding;
                        
                        // Save chunk to Firestore using FieldValue.vector for native vector search
                        await db.collection("chunks").add({
                            docId: docId,
                            docName: docData.name,
                            pageNumber: pageNumber,
                            text: chunkText,
                            embedding: FieldValue.vector(embedding),
                            uploadDate: new Date()
                        });
                    }
                }
                
                // Update parent status to "Indexed"
                await docRef.update({ status: "Indexed" });
                console.log(`Successfully indexed "${docData.name}".`);
                
            } catch (err) {
                console.error(`Error processing "${docData.name}":`, err);
                await docRef.update({ status: "Error" });
            }
        });
    }, (error) => {
        console.error("Ingestion listener error:", error);
    });

// Search API Endpoint: /ask
app.post('/ask', async (req, res) => {
    const { question } = req.body;
    
    if (!question || question.trim() === "") {
        return res.status(400).json({ error: "Question cannot be empty." });
    }
    
    try {
        console.log(`Searching answers for query: "${question}"...`);
        
        // 1. Generate query embedding
        const queryEmbeddingResponse = await openai.embeddings.create({
            model: "text-embedding-3-small",
            input: question
        });
        const queryEmbedding = queryEmbeddingResponse.data[0].embedding;
        
        // 2. Perform native vector search using findNearest
        const query = db.collection("chunks").findNearest({
            vectorField: 'embedding',
            queryVector: queryEmbedding,
            limit: 4,
            distanceMeasure: 'COSINE'
        });

        const chunksSnap = await query.get();
        if (chunksSnap.empty) {
            return res.json({
                answer: "No documents have been uploaded or indexed yet. Please go to the admin panel and upload PDFs.",
                sourcePdf: "-",
                pageNumber: "-",
                confidence: "-",
                clause: "-"
            });
        }
        
        // 3. Build top chunks and compute cosine similarity of the top match for confidence scoring
        let topChunks = [];
        chunksSnap.forEach((doc) => {
            const chunkData = doc.data();
            topChunks.push(chunkData);
        });

        // Compute similarity of top result to display in confidence card
        const topDoc = topChunks[0];
        const topVector = topDoc.embedding ? topDoc.embedding.toArray() : [];
        const highestSimilarity = topVector.length > 0 ? cosineSimilarity(queryEmbedding, topVector) : 0.99;
        
        console.log(`Highest similarity match score: ${highestSimilarity}`);
        if (highestSimilarity < 0.25) {
            return res.json({
                answer: "I couldn't find any relevant sections in the uploaded manuals to answer your question.",
                sourcePdf: "-",
                pageNumber: "-",
                confidence: "Low",
                clause: "-"
            });
        }
        
        // 5. Construct Prompt with context chunks
        let contextText = "";
        topChunks.forEach((chunk, index) => {
            contextText += `\n--- Context block ${index + 1} (Source: ${chunk.docName}, Page: ${chunk.pageNumber}) ---\n${chunk.text}\n`;
        });
        
        const systemPrompt = `You are an expert AI assistant answering employee questions about company guidelines, manuals, rules, or circulars.
Use ONLY the context blocks below to answer the user's question. 

Guidelines:
- Provide a clear, detailed, and professional answer based strictly on the context.
- If the answer cannot be found in the context, state "I cannot find the answer in the uploaded manuals."
- Format the response in concise paragraphs.
- Keep the language simple and helpful.`;

        const userPrompt = `Context:
${contextText}

Question: ${question}

Answer:`;

        // 6. Call OpenAI GPT-4o-mini to get response
        const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userPrompt }
            ],
            temperature: 0.2
        });
        
        const answer = completion.choices[0].message.content;
        
        // Match details for the stats cards
        const primarySource = topChunks[0];
        
        res.json({
            answer: answer,
            sourcePdf: primarySource.docName,
            pageNumber: primarySource.pageNumber.toString(),
            confidence: `${Math.round(highestSimilarity * 100)}%`,
            clause: "General" // Or parse headings if available in document structure
        });
        
    } catch (err) {
        console.error("QA search endpoint error:", err);
        res.status(500).json({ error: "Internal server error occurred." });
    }
});

// Clean up: delete document chunks from Firestore when a document metadata is deleted
db.collection("documents").onSnapshot((snapshot) => {
    snapshot.docChanges().forEach(async (change) => {
        if (change.type === "removed") {
            const docId = change.doc.id;
            const docData = change.doc.data();
            console.log(`Document "${docData.name}" removed from Firestore. Deleting associated chunks...`);
            
            try {
                const chunksSnap = await db.collection("chunks").where("docId", "==", docId).get();
                if (!chunksSnap.empty) {
                    const batch = db.batch();
                    chunksSnap.forEach(chunkDoc => batch.delete(chunkDoc.ref));
                    await batch.commit();
                    console.log(`Deleted ${chunksSnap.size} chunks for "${docData.name}".`);
                }
            } catch (err) {
                console.error(`Failed to delete chunks for "${docData.name}":`, err);
            }
        }
    });
});

// Start Server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`RAG backend server is listening on port ${PORT}...`);
});
