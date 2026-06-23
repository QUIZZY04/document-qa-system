async function testAbbrev() {
  const query = "what does ED stand for?";
  console.log(`Sending query: "${query}"`);
  
  try {
    const response = await fetch("http://localhost:5000/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: query })
    });
    const data = await response.json();
    console.log("=== Response ===");
    console.log(`Answer:     ${data.answer}`);
    console.log(`Confidence: ${data.confidence}`);
  } catch (err) {
    console.error("Test failed:", err);
  }
}

testAbbrev();
