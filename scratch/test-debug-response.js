async function debug() {
  console.log("Checking local server...");
  try {
    const response = await fetch("http://localhost:5000/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "Who is approving authority under DOP clause 4.3 for Rs 26 lakh?" })
    });
    const text = await response.text();
    console.log("Local response:", text);
  } catch (err) {
    console.log("Local check failed:", err.message);
  }
}

debug().then(() => process.exit(0));
