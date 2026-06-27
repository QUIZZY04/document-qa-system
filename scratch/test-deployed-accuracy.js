const tests = [
  {
    q: "what is the margin of purchase preference for Class-I local suppliers?",
    expectedContains: ["margin", "20%"],
    expectLowConfidence: false,
    note: "Valid general document query"
  },
  {
    q: "what does ED stand for?",
    expectedContains: ["Executive Director"],
    expectLowConfidence: false,
    note: "Abbreviation check"
  },
  {
    q: "Who is approving authority under DOP clause 4.3 for Rs 26 lakh?",
    expectedContains: ["Senior Manager", "SM"],
    expectLowConfidence: false,
    note: "Deterministic clause search"
  },
  {
    q: "what is the recipe for chocolate chip cookies?",
    expectedContains: ["couldn't find the answer", "could not find", "नहीं मिला"],
    expectLowConfidence: true,
    note: "Out of context query"
  }
];

async function runTests() {
  let passed = 0;
  for (const t of tests) {
    try {
      const response = await fetch("https://asia-south1-robotic-af198.cloudfunctions.net/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: t.q })
      });
      const data = await response.json();
      const ansText = data.answer || "";
      const confidence = data.confidence || "";
      
      const textMatches = t.expectedContains.some(c => ansText.toLowerCase().includes(c.toLowerCase()));
      const confidenceMatches = t.expectLowConfidence ? (confidence === "Low" || confidence === "-") : (confidence !== "Low" && confidence !== "-");
      
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
