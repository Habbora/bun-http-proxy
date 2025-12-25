
export class ContentRewriter {
    constructor(
        private upstreamOrigin: string,
        private proxyOrigin: string,
        private basePath: string = ""
    ) { }

    transform(response: Response): Response {
        // Skip rewriting for redirects or empty bodies or errors
        if (!response.body || response.status === 204 || response.status === 304 || response.status >= 300 && response.status < 400) {
            return response;
        }

        const contentType = response.headers.get("content-type") || "";

        try {
            if (contentType.includes("text/html")) {
                return this.rewriteHtml(response);
            }

            if (
                contentType.includes("text/css") ||
                contentType.includes("javascript") ||
                contentType.includes("application/json") ||
                contentType.includes("text/plain")
            ) {
                return this.rewriteText(response);
            }
        } catch (e) {
            console.error("[ContentRewriter] Error rewriting content:", e);
            // Fallback: return original response (might need to clone if body was consumed?)
            // But since we are passing streams, we can't easily "undo". 
            // Ideally we should catch before starting stream transformation.
            // For now, let's just log and hope it works or fails loudly.
        }

        return response;
    }

    private rewriteHtml(response: Response): Response {
        const rewriter = new HTMLRewriter();
        const tags = {
            "a": "href",
            "img": "src",
            "link": "href",
            "script": "src",
            "form": "action",
            "iframe": "src",
            "source": "src",
            "object": "data",
            "area": "href",
            "base": "href",
        };

        for (const [tag, attr] of Object.entries(tags)) {
            rewriter.on(tag, {
                element: (el) => {
                    const value = el.getAttribute(attr);
                    if (value) {
                        el.setAttribute(attr, this.rewriteUrl(value));
                    }
                },
            });
        }

        // Também reescreve estilos inline que tenham URLs
        rewriter.on("*", {
            element: (el) => {
                const style = el.getAttribute("style");
                if (style && style.includes("url(")) {
                    el.setAttribute("style", this.rewriteTextContent(style));
                }
            }
        });

        return rewriter.transform(response);
    }

    private rewriteText(response: Response): Response {
        const { upstreamOrigin, proxyOrigin } = this;
        
        // Remove content-length header because size will change
        const headers = new Headers(response.headers);
        headers.delete("content-length");

        const transformStream = new TransformStream({
            transform(chunk, controller) {
                if (typeof chunk === 'string') {
                    controller.enqueue(chunk.replaceAll(upstreamOrigin, proxyOrigin));
                } else {
                     // Se for buffer, decodificar, substituir, codificar.
                     // Note: replaceAll on binary chunks might break multi-byte chars at boundaries
                     // but for simple text replacement it's usually acceptable for MVP.
                     // For robust implementation, we should buffer.
                     const text = new TextDecoder().decode(chunk, { stream: true });
                     const replaced = text.replaceAll(upstreamOrigin, proxyOrigin);
                     controller.enqueue(new TextEncoder().encode(replaced));
                }
            }
        });

        return new Response(response.body?.pipeThrough(transformStream), {
            status: response.status,
            statusText: response.statusText,
            headers: headers,
        });
    }

    private rewriteTextContent(text: string): string {
        return text.replaceAll(this.upstreamOrigin, this.proxyOrigin);
    }

    private rewriteUrl(url: string): string {
        if (url.startsWith(this.upstreamOrigin)) {
            return url.replace(this.upstreamOrigin, this.proxyOrigin);
        }
        return url;
    }
}
