const tests = [
  {
    name: "Greeting Test",
    q: "hi there",
    validate: (data) => {
      return data.answer.toLowerCase().includes("hello") && 
             data.answer.includes("chat-opt-btn") &&
             data.confidence === "100%" &&
             data.clause === "Greeting";
    }
  },
  {
    name: "Broad Query Test",
    q: "clause 4.3",
    validate: (data) => {
      return data.answer.includes("chat-opt-btn") &&
             data.clause.includes("4.3");
    }
  },
  {
    name: "Deterministic Query Test",
    q: "Who is approving authority under DOP clause 4.3 for Rs 2600000",
    validate: (data) => {
      return (data.answer.toLowerCase().includes("deputy general manager") || data.answer.toLowerCase().includes("dgm")) &&
             data.answer.includes("chat-opt-btn") &&
             data.clause.includes("4.3");
    }
  },
  {
    name: "Fallback Query Test",
    q: "recipe for vanilla cake",
    validate: (data) => {
      return data.answer.includes("chat-opt-btn") &&
             data.confidence === "Low";
    }
  }
];

async function runTests() {
  console.log("Running interactive options tests...\n");
  let passed = 0;
  for (const t of tests) {
    try {
      const response = await fetch("http://localhost:5000/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: t.q })
      });
      const data = await response.json();
      const isOK = t.validate(data);
      if (isOK) {
        console.log(`[PASS] ${t.name}`);
        passed++;
      } else {
        console.log(`[FAIL] ${t.name}`);
        console.log("   Query:", t.q);
        console.log("   Response Data:", JSON.stringify(data, null, 2));
      }
    } catch (err) {
      console.log(`[ERROR] ${t.name} -> ${err.message}`);
    }
  }
  console.log(`\nScore: ${passed}/${tests.length} tests passed.`);
  process.exit(passed === tests.length ? 0 : 1);
}

runTests();
