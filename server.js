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

// Map raw cosine similarity scores of OpenAI embeddings to an intuitive confidence percentage
function scaleConfidence(similarity) {
    if (similarity <= 0.2) return Math.round(similarity * 100);
    if (similarity <= 0.3) return Math.round(20 + (similarity - 0.2) * 300); // 20% to 50%
    if (similarity <= 0.5) return Math.round(50 + (similarity - 0.3) * 150); // 50% to 80%
    if (similarity <= 0.7) return Math.round(80 + (similarity - 0.5) * 80);  // 80% to 96%
    return Math.round(96 + (similarity - 0.7) * 15); // 96% to 99% (cap at 99%)
}


// Custom page-by-page PDF parser using smart Y-tolerance and X-sorting to preserve table alignments
async function parsePdfPages(buffer) {
    let pagesText = [];
    
    function render_page(pageData) {
        let render_options = {
            normalizeWhitespace: true,
            disableCombineTextItems: false
        };
        
        return pageData.getTextContent(render_options)
            .then(function(textContent) {
                const items = textContent.items;
                if (items.length === 0) {
                    pagesText.push("");
                    return "";
                }
                
                // Group by Y coordinate with a tolerance of 4 units
                const tolerance = 4;
                let rows = [];
                
                for (let item of items) {
                    const text = item.str;
                    const x = item.transform[4];
                    const y = item.transform[5];
                    
                    let foundRow = rows.find(r => Math.abs(r.y - y) <= tolerance);
                    
                    if (foundRow) {
                        foundRow.items.push({ text, x, y });
                    } else {
                        rows.push({
                            y: y,
                            items: [{ text, x, y }]
                        });
                    }
                }
                
                // Sort rows from top to bottom (Y coordinate in PDF is bottom-up, so higher Y is higher on page)
                rows.sort((a, b) => b.y - a.y);
                
                // For each row, sort items from left to right (X coordinate)
                let lines = [];
                for (let row of rows) {
                    row.items.sort((a, b) => a.x - b.x);
                    const lineText = row.items.map(it => it.text).join(" ").replace(/\s+/g, " ");
                    lines.push(lineText);
                }
                
                const pageText = lines.join("\n");
                pagesText.push(pageText);
                return pageText;
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
const processingDocs = new Set();
db.collection("documents").where("status", "==", "Processing")
    .onSnapshot((snapshot) => {
        snapshot.forEach(async (docSnap) => {
            const docId = docSnap.id;
            if (processingDocs.has(docId)) return;
            processingDocs.add(docId);
            
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
                
                // 4. Generate embeddings and save chunks with header propagation
                let currentHeaders = "SI. Nature of Power | ED | G.M. | AGM | DGM | S.M.";
                for (let i = 0; i < pagesText.length; i++) {
                    const pageText = pagesText[i].trim();
                    const pageNumber = i + 1;
                    
                    if (pageText.length < 10) {
                        console.log(`Skipping empty or tiny page ${pageNumber}.`);
                        continue;
                    }

                    // Dynamically scan for headers on this page
                    const lines = pageText.split('\n');
                    for (const line of lines) {
                        const cleanLine = line.trim();
                        if (cleanLine.includes('ED') && cleanLine.includes('G.M.') && cleanLine.includes('AGM') && cleanLine.includes('DGM')) {
                            currentHeaders = cleanLine.replace(/\s+/g, ' ');
                        } else if (cleanLine.includes('TC') && cleanLine.includes('Nomination') && cleanLine.includes('Approval')) {
                            currentHeaders = cleanLine.replace(/\s+/g, ' ');
                        }
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
                        
                        // Prepend headers context to text for embedding rich search and accurate LLM answering
                        const prefixedText = `[Context - Document: ${docData.name} | Page: ${pageNumber} | Table Columns: ${currentHeaders}]\n${chunkText}`;

                        // Call OpenAI Embeddings API with prefixed text
                        const embeddingResponse = await openai.embeddings.create({
                            model: "text-embedding-3-small",
                            input: prefixedText
                        });
                        
                        const embedding = embeddingResponse.data[0].embedding;
                        
                        // Save chunk to Firestore using FieldValue.vector for native vector search
                        await db.collection("chunks").add({
                            docId: docId,
                            docName: docData.name,
                            pageNumber: pageNumber,
                            text: prefixedText,
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
            } finally {
                processingDocs.delete(docId);
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
        
        // Extract section/clause numbers (e.g. 4.1, 4.3)
        const clauseRegex = /\b\d+\.\d+\b/g;
        const clauseMatches = question.match(clauseRegex) || [];
        console.log(`Extracted clause numbers from query:`, clauseMatches);

        // 2. Perform native vector search using findNearest (expanded limit to 15 to allow reranking)
        const query = db.collection("chunks").findNearest({
            vectorField: 'embedding',
            queryVector: queryEmbedding,
            limit: 15,
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
        
        // 3. Build all chunks with cosine similarity and keyword boosting
        let allChunks = [];
        chunksSnap.forEach((doc) => {
            const chunkData = doc.data();
            const vec = chunkData.embedding ? chunkData.embedding.toArray() : [];
            const similarity = vec.length > 0 ? cosineSimilarity(queryEmbedding, vec) : 0;
            
            // Check if chunk text contains any of the clause numbers from the query
            let isExactClauseMatch = false;
            for (const clauseNum of clauseMatches) {
                if (chunkData.text && chunkData.text.includes(clauseNum)) {
                    isExactClauseMatch = true;
                    break;
                }
            }
            
            // Apply keyword boosting to score
            const boostedSimilarity = isExactClauseMatch ? similarity + 0.25 : similarity;
            allChunks.push({
                ...chunkData,
                rawSimilarity: similarity,
                boostedSimilarity: boostedSimilarity,
                isExactClauseMatch: isExactClauseMatch
            });
        });

        // Sort chunks by boosted similarity score descending
        allChunks.sort((a, b) => b.boostedSimilarity - a.boostedSimilarity);
        
        // Take the top 6 chunks for prompt context
        let topChunks = allChunks.slice(0, 6);

        // Compute similarity of top result to display in confidence card
        const topDoc = topChunks[0];
        const highestSimilarity = topDoc.rawSimilarity || 0.99;
        const confidencePercentage = scaleConfidence(highestSimilarity);
        
        console.log(`Highest similarity match score: ${highestSimilarity} -> scaled to confidence: ${confidencePercentage}%`);
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

You must respond with a JSON object containing the following keys:
- "answer": A clear, detailed, and professional answer based strictly on the context. If the answer cannot be found in the context, state "I cannot find the answer in the uploaded manuals."
- "clause": The specific clause number, section number, title, or heading (e.g., "Clause 4.2", "Section II", "Annexure A", "Para 3.1") from the context that contains the answer. If no specific clause/section can be identified, write "General".

Guidelines:
- Define acronyms as: ED = Executive Director, GM = General Manager, AGM = Additional General Manager, DGM = Deputy General Manager, SM / S.M. = Senior Manager.
- CLAUSE SPECIFICITY RULE: The user is asking about a specific clause number (e.g. Clause 4.3). You MUST look ONLY at the limits, columns, and values defined under that exact clause number in the context. Do NOT get confused by or use values from other clauses (such as Clause 4.1 or 4.2) that may also be present in the context blocks.
- TABLE ALIGNMENT RULE: The tables in the context are extracted line-by-line where vertical column values might be split across consecutive rows (e.g., "Full Full Upto Upto -" on one row, followed by "Powers Powers Rs.20 Rs.10" on the next, and "lakh lakh. -" on the next). You MUST mentally align these columns under the headers (ED, G.M., AGM, DGM, S.M.) from left to right:
  * Column 1 (ED): e.g. "Full" + "Powers" = Full Powers
  * Column 2 (G.M.): e.g. "Full" + "Powers" = Full Powers
  * Column 3 (AGM): e.g. "Upto" + "Rs.20" + "lakh" = Upto Rs.20 lakh (representing Additional General Manager)
  * Column 4 (DGM): e.g. "Upto" + "Rs.10" + "lakh." = Upto Rs.10 lakh
  * Column 5 (S.M.): e.g. "-" + "-" = - (No powers)
  Be extremely careful. For a value of Rs. 15 lakh under Clause 4.1, AGM (Additional General Manager) is the lowest level authority (limit up to Rs. 20 lakh). But for Clause 4.3, DGM has limit Upto Rs. 50 lakh, and SM has limit Upto Rs. 10 lakh.
- LOGICAL THRESHOLD RULES: When checking approval powers for a target value:
  * Find the lowest level authority whose delegation limit is greater than or equal to the target value. That is the competent approving authority.
  * If the target value exceeds a level's limit (e.g., Rs. 21 lakh exceeds S.M.'s limit of Rs. 10 lakh under Clause 4.3, but is less than DGM's limit of Rs. 50 lakh), that level CANNOT approve it, and you must check the next level. Directly state the competent authority level (e.g., Deputy General Manager (DGM) for Rs. 21 lakh under Clause 4.3) and do not say it "falls under" the lower level.
- Do not make up any clauses; only extract what is explicitly written in the context.
- Format the answer in concise paragraphs.
- Keep the language simple and helpful.`;

        const userPrompt = `Context:
${contextText}

Question: ${question}

Answer JSON (containing "answer" and "clause" keys):`;

        // 6. Call OpenAI GPT-4o to get response
        const completion = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userPrompt }
            ],
            response_format: { type: "json_object" },
            temperature: 0.2
        });
        
        let answer = "";
        let clause = "General";
        try {
            const responseData = JSON.parse(completion.choices[0].message.content);
            answer = responseData.answer;
            clause = responseData.clause || "General";
        } catch (jsonErr) {
            console.error("Failed to parse GPT JSON response:", jsonErr);
            answer = completion.choices[0].message.content;
        }
        
        // Match details for the stats cards
        const primarySource = topChunks[0];
        
        res.json({
            answer: answer,
            sourcePdf: primarySource.docName,
            pageNumber: primarySource.pageNumber.toString(),
            confidence: `${confidencePercentage}%`,
            clause: clause
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
