async function testValidGeneral() {
  const query = "what does clause 4.3 cover?";
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
    console.log(`Clause:     ${data.clause}`);
    console.log(`Source PDF: ${data.sourcePdf}`);
    console.log(`Page:       ${data.pageNumber}`);
  } catch (err) {
    console.error("Test failed:", err);
  }
}

testValidGeneral();
