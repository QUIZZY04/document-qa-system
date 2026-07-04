const tests = [
    { q: "who is approving authority for Rs 2600000 under clause 19", label: "Clause 19, Rs 26L" },
    { q: "who is approving authority for Rs 1000000 under clause 19", label: "Clause 19, Rs 10L" },
    { q: "who is approving authority for Rs 500000 under clause 19", label: "Clause 19, Rs 5L" },
    { q: "who is approving authority for Rs 2600000 under clause 20", label: "Clause 20, Rs 26L" },
    { q: "who is approving authority for Rs 2600000 under clause 13", label: "Clause 13, Rs 26L" },
];

async function run() {
    for (const t of tests) {
        try {
            const res = await fetch("http://localhost:5000/ask", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ question: t.q })
            });
            const data = await res.json();
            console.log(`\n[${t.label}]`);
            console.log(`  Confidence: ${data.confidence} | Clause: ${data.clause}`);
            // Strip HTML tags for readability
            const clean = data.answer.replace(/<[^>]+>/g, '').replace(/\n+/g, ' ').trim();
            console.log(`  Answer: ${clean.substring(0, 200)}`);
        } catch(e) {
            console.error(`[${t.label}] ERROR:`, e.message);
        }
    }
}
run();
