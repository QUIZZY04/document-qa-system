const tests = [
  {
    name: "Clause 15 Sub-clause buttons test",
    q: "tell me about clause 15",
    validate: (data) => {
      const ans = data.answer.toLowerCase();
      return ans.includes("15(a)") &&
             ans.includes("15(b)") &&
             ans.includes("15(c)") &&
             data.answer.includes("chat-opt-btn") &&
             data.answer.includes("selectSuggestion('tell me about clause 15(a)')");
    }
  },
  {
    name: "Clause 4 Remarks test",
    q: "what are the rules under clause 4.3?",
    validate: (data) => {
      const ans = data.answer.toLowerCase();
      // Clause 4 has remarks/notes about TC recommendations, proprietary items, proprietary purchases etc.
      // Let's ensure the response mentions key terms like 'remarks' or 'notes' or specific conditions.
      console.log("   Answer:", data.answer);
      return ans.includes("remark") || ans.includes("note") || ans.includes("committee") || ans.includes("tender");
    }
  }
];

async function run() {
  console.log("Starting local QA accuracy verification...");
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
  console.log(`\nLocal verification complete: ${passed}/${tests.length} passed.`);
  process.exit(passed === tests.length ? 0 : 1);
}

run();
