const tests = [
  {
    q: "what is the margin of purchase preference for Class-I local suppliers?",
    expectedContains: ["margin of purchase preference", "20%"],
    expectLowConfidence: false,
    note: "Valid general document query"
  },
  {
    q: "what is the recipe for chocolate chip cookies?",
    expectedContains: ["couldn't find the answer", "could not find the answer"],
    expectLowConfidence: true,
    note: "Out of context query"
  }
];

async function runTests() {
  let passed = 0;
  for (const t of tests) {
    try {
      const response = await fetch("http://localhost:5000/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: t.q })
      });
      const data = await response.json();
      const ansText = data.answer || "";
      const confidence = data.confidence || "";
      
      const textMatches = t.expectedContains.some(c => ansText.toLowerCase().includes(c.toLowerCase()));
      const confidenceMatches = t.expectLowConfidence ? (confidence === "Low" || confidence === "0%") : (confidence !== "Low");
      
      if (textMatches && confidenceMatches) {
        console.log(`[PASS] Query: "${t.q}"\n   -> Answer: "${ansText}"\n   -> Confidence: "${confidence}"`);
        passed++;
      } else {
        console.log(`[FAIL] Query: "${t.q}"\n   -> Answer: "${ansText}"\n   -> Confidence: "${confidence}" (Expected text match: ${t.expectedContains.join('/')}, Expected Low Confidence: ${t.expectLowConfidence})`);
      }
    } catch (err) {
      console.log(`[ERROR] Query: "${t.q}" -> ${err.message}`);
    }
  }
  console.log(`\nScore: ${passed}/${tests.length} tests passed.`);
}

runTests();
