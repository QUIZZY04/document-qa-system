const tests = [
  { q: 'who is approving authority under DOP clause 4.3 for Rs 2600000',  expected: 'DGM', note: 'Rs.26L < DGM limit Rs.50L' },
  { q: 'who is approving authority under DOP clause 4.3 for Rs 2100000',  expected: 'DGM', note: 'Rs.21L < DGM limit Rs.50L' },
  { q: 'who is approving authority under DOP clause 4.3 for Rs 5100000',  expected: 'AGM', note: 'Rs.51L > DGM (50L), <= AGM (200L)' },
  { q: 'who is approving authority under DOP clause 4.3 for Rs 51 lakh',   expected: 'AGM' },
  { q: 'who is approving authority under DOP clause 4.3 for Rs 21 lakh',   expected: 'DGM' },
  { q: 'who is approving authority under DOP clause 4.3 for Rs 2 lakh',    expected: 'SM',  note: 'Rs.2L <= SM limit Rs.10L' },
  { q: 'who is approving authority under DOP clause 4.3 for Rs 10 lakh',   expected: 'SM' },
  { q: 'who is approving authority under DOP clause 4.3 for Rs 11 lakh',   expected: 'DGM' },
  { q: 'who is approving authority under DOP clause 4.3 for Rs 1.5 crore', expected: 'AGM', note: '150L <= AGM (200L)' },
  { q: 'who is approving authority under DOP clause 4.3 for Rs 3 crore',   expected: 'GM',  note: '300L > AGM (200L), GM is Full Powers' }
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
      const matchesExpected = ansText.includes(t.expected);
      if (matchesExpected) {
        console.log(`[PASS] Query: "${t.q}" -> "${ansText.replace(/\n/g, ' ')}" (Expected: ${t.expected})`);
        passed++;
      } else {
        console.log(`[FAIL] Query: "${t.q}" -> "${ansText.replace(/\n/g, ' ')}" (Expected: ${t.expected})`);
      }
    } catch (err) {
      console.log(`[ERROR] Query: "${t.q}" -> ${err.message}`);
    }
  }
  console.log(`\nScore: ${passed}/${tests.length} tests passed.`);
}

runTests();
