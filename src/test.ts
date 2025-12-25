import * as cheerio from 'cheerio';

const TARGET = 'https://www.uol.com.br';
const PROXY_URL = 'http://localhost:3000';

Bun.serve({
  port: 3000,

  async fetch(req: Request) {
    const url = new URL(req.url);

    // Monta URL do upstream
    const upstreamUrl = `${TARGET}${url.pathname}${url.search}`;

    console.log(`[proxy] ${req.method} ${url.pathname}`);

    // Copia headers, mas ajusta o Host
    const headers = new Headers(req.headers);
    headers.set('host', new URL(TARGET).host);

    // Faz request pro upstream
    const upstreamRes = await fetch(upstreamUrl, {
      method: req.method,
      headers: headers,
      body: req.body,
      redirect: 'manual' // importante para controlar redirects
    });

    const contentType = upstreamRes.headers.get('content-type') || '';

    // Reescreve HTML
    if (contentType.includes('text/html')) {
      let html = await upstreamRes.text();
      const $ = cheerio.load(html);

      // Reescreve URLs em atributos
      const attrs = ['href', 'src', 'action', 'data-src', 'srcset'];
      attrs.forEach(attr => {
        $(`[${attr}]`).each((i, el) => {
          let value = $(el).attr(attr);
          if (value) {
            // URLs absolutas
            value = value.replace(new RegExp(TARGET, 'g'), PROXY_URL);
            // Protocol-relative URLs
            value = value.replace(/\/\/www\.uol\.com\.br/g, `//localhost:3000`);
            $(el).attr(attr, value);
          }
        });
      });

      // Reescreve dentro de <style> e <script>
      $('style, script').each((i, el) => {
        let content = $(el).html();
        if (content) {
          content = content.replace(new RegExp(TARGET, 'g'), PROXY_URL);
          $(el).html(content);
        }
      });

      const newHeaders = new Headers(upstreamRes.headers);
      newHeaders.delete('content-encoding');
      newHeaders.delete('content-length');
      newHeaders.delete('content-security-policy'); // pode bloquear recursos

      return new Response($.html(), {
        status: upstreamRes.status,
        statusText: upstreamRes.statusText,
        headers: newHeaders
      });
    }

    // Reescreve CSS
    if (contentType.includes('text/css')) {
      let css = await upstreamRes.text();
      css = css.replace(new RegExp(TARGET, 'g'), PROXY_URL);

      const newHeaders = new Headers(upstreamRes.headers);
      newHeaders.delete('content-encoding');
      newHeaders.delete('content-length');

      return new Response(css, {
        status: upstreamRes.status,
        headers: newHeaders
      });
    }

    // Reescreve JavaScript
    if (contentType.includes('javascript') || contentType.includes('json')) {
      let js = await upstreamRes.text();
      js = js.replace(new RegExp(TARGET, 'g'), PROXY_URL);

      const newHeaders = new Headers(upstreamRes.headers);
      newHeaders.delete('content-encoding');
      newHeaders.delete('content-length');

      return new Response(js, {
        status: upstreamRes.status,
        headers: newHeaders
      });
    }

    // Headers de redirect também precisam ser reescritos
    if (upstreamRes.status >= 300 && upstreamRes.status < 400) {
      const location = upstreamRes.headers.get('location');
      if (location) {
        const newHeaders = new Headers(upstreamRes.headers);
        const newLocation = location.replace(TARGET, PROXY_URL);
        newHeaders.set('location', newLocation);

        return new Response(null, {
          status: upstreamRes.status,
          headers: newHeaders
        });
      }
    }

    // Outros assets (imagens, fonts, etc) passam direto
    return new Response(upstreamRes.body, {
      status: upstreamRes.status,
      statusText: upstreamRes.statusText,
      headers: upstreamRes.headers
    });
  }
});

console.log(`🔄 Reverse proxy rodando em ${PROXY_URL}`);
