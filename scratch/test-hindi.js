const tests = [
  { 
    q: 'नमस्ते', 
    expectedType: 'Greeting', 
    expectedContent: 'नमस्ते', // Hindi greetings
    note: 'Hindi Greeting' 
  },
  { 
    q: 'DOP क्लॉज 4.3 के तहत 26 लाख रुपये के लिए मंजूरी देने वाला प्राधिकारी कौन है', 
    expectedType: 'Clause 4.3', 
    expectedContent: 'DGM', // Competent authority name
    note: 'Devanagari Hindi Deterministic Query (26 Lakh under 4.3 -> DGM)' 
  },
  { 
    q: 'clause 4.3 ke under 26 lakh rs ke liye approving authority kaun hai', 
    expectedType: 'Clause 4.3', 
    expectedContent: 'DGM',
    note: 'Hinglish/Transliterated Deterministic Query (26 Lakh under 4.3 -> DGM)' 
  },
  { 
    q: 'क्लॉज 4.3 में क्या शामिल है', 
    expectedType: 'Clause 4.3', 
    expectedContent: 'spares', // Should contain information about stores and spares
    note: 'Devanagari Hindi Grounded QA Query' 
  },
  { 
    q: 'clause 4.3 me kya cover kiya gaya hai', 
    expectedType: 'Clause 4.3', 
    expectedContent: 'spares',
    note: 'Hinglish Grounded QA Query' 
  },
  { 
    q: 'क्या क्लॉज 4.3 के तहत समोसे खरीदने का अधिकार है', 
    expectedType: 'Low/NotFound', 
    expectedContent: 'नहीं', // Hindi fallback not found
    note: 'Devanagari Hindi Off-topic/Not Found query' 
  }
];

async function runTests() {
  console.log("=== STARTING HINDI QA BACKEND TESTS ===");
  let passed = 0;
  
  for (let i = 0; i < tests.length; i++) {
    const t = tests[i];
    console.log(`\n[TEST ${i + 1}] ${t.note}`);
    console.log(`Query: "${t.q}"`);
    
    try {
      const response = await fetch("http://localhost:5000/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: t.q })
      });
      
      if (!response.ok) {
        throw new Error(`Server returned status ${response.status}`);
      }
      
      const data = await response.json();
      const ansText = data.answer || "";
      
      console.log(`- Answer: ${ansText.substring(0, 150).replace(/\n/g, ' ')}...`);
      console.log(`- Clause: ${data.clause} | Confidence: ${data.confidence} | Source PDF: ${data.sourcePdf}`);
      
      // Simple verification
      let containsExpected = false;
      if (t.expectedContent === 'spares') {
          containsExpected = ansText.toLowerCase().includes('spares') || 
                             ansText.includes('स्पेयर्स') || 
                             ansText.includes('स्टोर्स');
      } else {
          containsExpected = ansText.toLowerCase().includes(t.expectedContent.toLowerCase()) || 
                             ansText.includes(t.expectedContent);
      }
      
      if (containsExpected) {
        console.log(`[PASS] Verified successfully.`);
        passed++;
      } else {
        console.log(`[FAIL] Verification failed. Expected content like "${t.expectedContent}" not found in response.`);
      }
    } catch (err) {
      console.log(`[ERROR] Test failed with error: ${err.message}`);
    }
  }
  
  console.log(`\n=== TEST RUN FINISHED ===`);
  console.log(`Passed: ${passed}/${tests.length}`);
  if (passed === tests.length) {
    process.exit(0);
  } else {
    process.exit(1);
  }
}

runTests();
