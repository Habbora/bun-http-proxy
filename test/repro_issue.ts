
async function reproduce() {
    try {
        console.log("Sending request...");
        const res = await fetch("http://localhost:3000/", { 
            "headers": { 
              "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7", 
              "accept-language": "pt-BR,pt;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6", 
              "cache-control": "no-cache", 
              "pragma": "no-cache", 
              "sec-ch-ua": "\"Microsoft Edge\";v=\"143\", \"Chromium\";v=\"143\", \"Not A(Brand\";v=\"24\"", 
              "sec-ch-ua-mobile": "?0", 
              "sec-ch-ua-platform": "\"Windows\"", 
              "sec-fetch-dest": "document", 
              "sec-fetch-mode": "navigate", 
              "sec-fetch-site": "none", 
              "sec-fetch-user": "?1", 
              "upgrade-insecure-requests": "1" 
            }, 
            "method": "GET", 
            "redirect": "manual"
          });
        
        console.log("Status:", res.status);
        console.log("Headers:", Object.fromEntries(res.headers));
        
        const text = await res.text();
        console.log("Body length:", text.length);
        if (text.length < 500) console.log("Body preview:", text);
        
    } catch (e) {
        console.error("Error:", e);
    }
}

reproduce();
