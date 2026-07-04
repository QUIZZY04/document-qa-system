const tests = [
    { q: "who is approving authority under clause 1(c)(i) for Rs 50 lakh", label: "Clause 1(c)(i), Rs 50L" },
    { q: "who is approving authority under clause 1(c)(ii) for Rs 15 lakh", label: "Clause 1(c)(ii), Rs 15L" },
    { q: "who is approving authority under clause 1(c)(ii) for Rs 5 lakh", label: "Clause 1(c)(ii), Rs 5L" },
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
            console.log(`  Answer:\n${data.answer}`);
        } catch(e) {
            console.error(`[${t.label}] ERROR:`, e.message);
        }
    }
}
run();
