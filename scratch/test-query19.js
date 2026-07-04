const testQueries = [
    { q: "how to bake a cake", expected: "-" }
];

async function run() {
    for (const q of testQueries) {
        try {
            const response = await fetch("http://localhost:5000/ask", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ question: q.q })
            });
            const data = await response.json();
            console.log(`Query: "${q.q}" -> Status: ${response.status} | Confidence: ${data.confidence} | Clause: ${data.clause}`);
            console.log("Answer:\n", data.answer);
        } catch (err) {
            console.error(`Query: "${q.q}" -> ERROR:`, err.message);
        }
    }
}

run();
