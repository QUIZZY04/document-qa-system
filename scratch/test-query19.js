const testQueries = [
    { q: "clause 15b", expected: "Clause 15(b)" },
    { q: "clause 15 b", expected: "Clause 15(b)" },
    { q: "clause 15(b)", expected: "Clause 15(b)" },
    { q: "clause 15B", expected: "Clause 15(b)" },
    { q: "clause 15 B", expected: "Clause 15(b)" },
    { q: "clause 15 (B)", expected: "Clause 15(b)" },
    { q: "clause 15(B)", expected: "Clause 15(b)" },
    { q: "clause 15 . b", expected: "Clause 15(b)" },
    { q: "clause 15 ( b )", expected: "Clause 15(b)" },
    { q: "clause 15 sub-clause b", expected: "Clause 15(b)" },
    { q: "clause 15 sub clause B", expected: "Clause 15(b)" },
    { q: "clause 15 part b", expected: "Clause 15(b)" },
    { q: "clause 15-b", expected: "Clause 15(b)" },
    { q: "clause 15/b", expected: "Clause 15(b)" },
    { q: "clause 4 . 3", expected: "Clause 4.3" },
    { q: "clause 17.1 b", expected: "Clause 17.1" },
    { q: "clause 17.1(b)", expected: "Clause 17.1" },
    { q: "clause 17.1 (B)", expected: "Clause 17.1" }
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
            if (data.clause !== q.expected) {
                console.log(`    [WARN] Resolved to incorrect clause: "${data.clause}" (Expected: "${q.expected}")`);
            }
        } catch (err) {
            console.error(`Query: "${q.q}" -> ERROR:`, err.message);
        }
    }
}

run();
