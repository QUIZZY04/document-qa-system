async function run() {
  console.log("Testing Clause 1 general query on deployed Firebase function...");
  try {
    const response = await fetch("https://asia-south1-robotic-af198.cloudfunctions.net/api/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "tell me about clause 1" })
    });
    const data = await response.json();
    console.log("\nQuery: \"tell me about clause 1\"");
    console.log("--------------------------------------------------------------------------------");
    console.log("Answer:", data.answer);
    console.log("--------------------------------------------------------------------------------");
    console.log("Confidence:", data.confidence);
    console.log("Clause:", data.clause);
  } catch (err) {
    console.error("Error running verification:", err);
  }
}

run().then(() => process.exit(0));
