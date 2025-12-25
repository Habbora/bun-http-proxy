import { BunReverseProxy } from "../src/server";

// 1. Upstream Server
const upstream = Bun.serve({
    port: 0,
    fetch(req) {
        const url = new URL(req.url);
        const origin = url.origin;

        if (url.pathname === "/html") {
            return new Response(`
                <html>
                    <body>
                        <a href="${origin}/page">Link</a>
                        <img src="${origin}/image.png" />
                        <form action="${origin}/submit"></form>
                    </body>
                </html>
            `, { headers: { "content-type": "text/html" } });
        }

        if (url.pathname === "/style.css") {
            return new Response(`
                body { background: url('${origin}/bg.png'); }
            `, { headers: { "content-type": "text/css" } });
        }

        if (url.pathname === "/redirect") {
            return new Response(null, {
                status: 302,
                headers: { "location": `${origin}/target` }
            });
        }

        return new Response("OK");
    }
});

console.log(`Upstream running on ${upstream.port}`);

// 2. Proxy Server
const proxy = new BunReverseProxy({
    port: 0,
    debug: true,
    rewriteContent: true,
    routes: {
        "test.local": `http://localhost:${upstream.port}`
    }
});

console.log(`Proxy running on ${proxy.port}`);

// 3. Validation
const proxyBase = `http://localhost:${proxy.port}`;
const headers = { "Host": `test.local:${proxy.port}` };

async function runTests() {
    try {
        // Test HTML Rewriting
        console.log("Testing HTML Rewriting...");
        const htmlRes = await fetch(`${proxyBase}/html`, { headers });
        const html = await htmlRes.text();
        
        if (!html.includes(`href="http://test.local:${proxy.port}/page"`)) throw new Error("Link not rewritten");
        if (!html.includes(`src="http://test.local:${proxy.port}/image.png"`)) throw new Error("Image not rewritten");
        console.log("PASS: HTML Rewriting");

        // Test CSS Rewriting
        console.log("Testing CSS Rewriting...");
        const cssRes = await fetch(`${proxyBase}/style.css`, { headers });
        const css = await cssRes.text();
        
        if (!css.includes(`url('http://test.local:${proxy.port}/bg.png')`)) throw new Error("CSS URL not rewritten");
        console.log("PASS: CSS Rewriting");

        // Test Redirect Rewriting
        console.log("Testing Redirect Rewriting...");
        const redirectRes = await fetch(`${proxyBase}/redirect`, { headers, redirect: "manual" });
        const location = redirectRes.headers.get("location");
        
        if (location !== `http://test.local:${proxy.port}/target`) throw new Error(`Redirect not rewritten: ${location}`);
        console.log("PASS: Redirect Rewriting");

    } catch (e) {
        console.error("FAIL:", e);
        process.exit(1);
    } finally {
        upstream.stop();
        proxy.stop();
        process.exit(0);
    }
}

runTests();
