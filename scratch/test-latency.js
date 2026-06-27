const tests = [
  {
    name: "Direct Clause Query (Bypasses Embeddings)",
    q: "Who is approving authority under DOP clause 4.3 for Rs 26 lakh?"
  },
  {
    name: "General Vector Query (Generates Embeddings)",
    q: "what does ED stand for?"
  }
];

async function measure() {
  console.log("Measuring Cloud Function response times...");
  for (const t of tests) {
    const start = Date.now();
    try {
      const response = await fetch("https://asia-south1-robotic-af198.cloudfunctions.net/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: t.q })
      });
      const data = await response.json();
      const end = Date.now();
      console.log(`- ${t.name}: Took ${end - start}ms`);
    } catch (err) {
      console.log(`- ${t.name} failed: ${err.message}`);
    }
  }
}

measure().then(() => process.exit(0));
