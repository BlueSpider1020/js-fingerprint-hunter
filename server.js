// puppeteer-fp-full.js
const puppeteer = require('puppeteer');

(async () => {
  // === Config ===
  const HEADLESS = false;
  // Set a filter for network logging (string or RegExp). Example: 'eticketing.co.uk' or /eticketing\.co\.uk/
  // Set to null to log everything (can be very noisy).
  // const URL_FILTER = 'eticketing.co.uk';
  const URL_FILTER = null;

  // === Launch ===
  const browser = await puppeteer.launch({
    headless: HEADLESS,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();

  // Capture page console messages (our injected hooks use console.log)
  page.on('console', async msg => {
    try {
      const args = msg.args();
      const out = [];
      for (const a of args) {
        try { out.push(await a.jsonValue()); } catch { out.push(a.toString()); }
      }
      console.log('[PAGE]', ...out);
    } catch (e) {
      console.log('console capture error', e);
    }
  });

  // Storage for captured Set-Cookie headers and parsed cookies
  const capturedSetCookies = [];
  const parsedCookies = {};

  // Listen to network responses and grab Set-Cookie headers
  page.on('response', async response => {
    try {
      const url = response.url();
      const headers = response.headers();
      const scHeader = headers['set-cookie'] || headers['Set-Cookie'] || headers['set-cookie2'];
      if (scHeader) {
        let cookieStrings = scHeader.split(/\r?\n/).flatMap(s => s.split(/,(?=[^;]+=)/));
        cookieStrings = cookieStrings.map(s => s.trim()).filter(Boolean);

        cookieStrings.forEach(cookieStr => {
          capturedSetCookies.push({ url, cookieStr });
          console.log(`[SET-COOKIE] ${url}  ->  ${cookieStr}`);

          const parts = cookieStr.split(';').map(p => p.trim());
          const [nameVal, ...attrs] = parts;
          const eqIdx = nameVal.indexOf('=');
          if (eqIdx > -1) {
            const name = nameVal.slice(0, eqIdx).trim();
            const value = nameVal.slice(eqIdx + 1).trim();
            const attrObj = {};
            attrs.forEach(a => {
              const aEq = a.indexOf('=');
              if (aEq > -1) {
                const k = a.slice(0, aEq).trim();
                const v = a.slice(aEq + 1).trim();
                attrObj[k.toLowerCase()] = v;
              } else {
                attrObj[a.toLowerCase()] = true;
              }
            });

            if (!parsedCookies[name]) parsedCookies[name] = [];
            parsedCookies[name].push({ url, cookieString: cookieStr, value, attrs: attrObj });

            if (name === 'tmpt') {
              console.log('[TMPT-COOKIE CAPTURED]', { url, cookieString: cookieStr, value, attrs: attrObj });
            }
          }
        });
      }
    } catch (e) {
      console.error('response handler error', e);
    }
  });

  // Inject hooks before any script runs
  await page.evaluateOnNewDocument((urlFilter) => {
    const prefix = 'FP-HOOK';

    // small helper
    function safeRun(fn) { try { fn(); } catch (e) { try { console.warn(prefix, 'hook error', e && e.message); } catch {} } }
    function hookProp(obj, prop, label, opts = {}) {
      safeRun(() => {
        const target = obj;
        const desc = Object.getOwnPropertyDescriptor(target, prop);
        if (!desc || desc.configurable) {
          const origVal = target[prop];
          Object.defineProperty(target, prop, {
            configurable: true,
            enumerable: true,
            get() { try { console.log(prefix, `${label}.${prop} read ->`, origVal); } catch (e) {} return opts.wrap ? opts.wrap(origVal) : origVal; }
          });
        }
      });
    }
    function hookMethod(obj, methodName, label) {
      safeRun(() => {
        const orig = obj[methodName];
        if (!orig || orig.__fp_hooked) return;
        const wrapped = function (...args) { try { console.log(prefix, `${label}.${methodName} called -> args:`, args); } catch (e) {} return orig.apply(this, args); };
        wrapped.__fp_hooked = true;
        obj[methodName] = wrapped;
      });
    }

    // Utility for url filtering inside page
    function shouldLogUrl(url) {
      if (!urlFilter) return true;
      try {
        if (urlFilter instanceof RegExp) return urlFilter.test(url);
        return String(url).includes(String(urlFilter));
      } catch (e) { return true; }
    }

    // --- Screen / window dimensions ---
    safeRun(() => {
      hookProp(window, 'innerWidth', 'window'); hookProp(window, 'innerHeight', 'window');
      hookProp(window, 'outerWidth', 'window'); hookProp(window, 'outerHeight', 'window');
      try {
        const realScreen = window.screen;
        const screenProxy = new Proxy(realScreen, {
          get(target, prop) {
            try {
              if (typeof prop === 'string' && prop.match(/(availWidth|availHeight|width|height|colorDepth|pixelDepth|orientation)/)) {
                console.log(prefix, `screen.${prop} read ->`, target[prop]);
              }
            } catch (e) {}
            return Reflect.get(target, prop);
          }
        });
        Object.defineProperty(window, 'screen', { configurable: true, enumerable: true, value: screenProxy });
      } catch (e) {}
    });

    // --- Navigator ---
    safeRun(() => {
      [
        // 'userAgent', 
        'platform', 'language', 'languages', 'hardwareConcurrency', 'deviceMemory', 'maxTouchPoints', 'vendor', 'productSub', 'oscpu'].forEach(p => hookProp(navigator, p, 'navigator'));
      try {
        const pluginsDesc = Object.getOwnPropertyDescriptor(Navigator.prototype, 'plugins') || Object.getOwnPropertyDescriptor(navigator.__proto__, 'plugins');
        if (pluginsDesc && pluginsDesc.get) {
          const origGet = pluginsDesc.get.bind(navigator);
          Object.defineProperty(navigator, 'plugins', { configurable: true, get() { const p = origGet(); console.log(prefix, 'navigator.plugins read ->', p && p.length); return p; } });
        }
      } catch (e) {}
      try {
        const mDesc = Object.getOwnPropertyDescriptor(Navigator.prototype, 'mimeTypes') || Object.getOwnPropertyDescriptor(navigator.__proto__, 'mimeTypes');
        if (mDesc && mDesc.get) {
          const origGet = mDesc.get.bind(navigator);
          Object.defineProperty(navigator, 'mimeTypes', { configurable: true, get() { const m = origGet(); console.log(prefix, 'navigator.mimeTypes read ->', m && m.length); return m; } });
        }
      } catch (e) {}
    });

    // --- Read-only document.URL / document.domain / location pathname/query/hash (history) ---
    /*safeRun(() => {
      const fakeLocation = {
        href: "https://www.eticketing.co.uk/tottenhamhotspur/Events",
        origin: "https://www.eticketing.co.uk",
        pathname: "/tottenhamhotspur/Events",
        search: "",
        hash: "",
        hostname: "www.eticketing.co.uk",
        host: "www.eticketing.co.uk",
        protocol: "https:"
      };

      try {
        Object.defineProperty(document, 'URL', {
          configurable: true,
          get() { console.log(prefix, "document.URL read ->", fakeLocation.href); return fakeLocation.href; }
        });
      } catch (e) {}
      try {
        Object.defineProperty(document, 'URL', {
          configurable: true,
          get() { console.log(prefix, "document.origin read ->", fakeLocation.origin); return fakeLocation.origin; }
        });
      } catch (e) {}
      try {
        Object.defineProperty(document, 'domain', {
          configurable: true,
          get() { console.log(prefix, "document.domain read ->", fakeLocation.hostname); return fakeLocation.hostname; }
        });
      } catch (e) {}
      try {
        history.replaceState({}, "", fakeLocation.pathname + fakeLocation.search + fakeLocation.hash);
        console.log(prefix, "history.replaceState applied ->", window.location.href);
      } catch (e) {}
    });*/

    // --- document.cookie read/write ---
    safeRun(() => {
      try {
        const docDesc = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie') || Object.getOwnPropertyDescriptor(document.__proto__, 'cookie');
        if (docDesc && docDesc.get) {
          const origGet = docDesc.get.bind(document);
          const origSet = docDesc.set && docDesc.set.bind(document);
          Object.defineProperty(document, 'cookie', {
            configurable: true,
            get() { const v = origGet(); console.log(prefix, 'document.cookie read ->', v && v.length); return v; },
            set(val) { console.log(prefix, 'document.cookie set ->', val); if (origSet) origSet(val); }
          });
        }
      } catch (e) {}
    });

    // --- Canvas & WebGL hooks ---
    safeRun(() => {
      try {
        const ctxProto = CanvasRenderingContext2D.prototype;
        hookMethod(ctxProto, 'getImageData', 'CanvasRenderingContext2D');
        hookMethod(HTMLCanvasElement.prototype, 'toDataURL', 'HTMLCanvasElement');
        hookMethod(HTMLCanvasElement.prototype, 'toBlob', 'HTMLCanvasElement');
        hookMethod(ctxProto, 'fillText', 'CanvasRenderingContext2D');
        hookMethod(ctxProto, 'strokeText', 'CanvasRenderingContext2D');
      } catch (e) {}
      try {
        const origGetContext = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
          const ctx = origGetContext.apply(this, [type, ...rest]);
          try {
            if (type === 'webgl' || type === 'experimental-webgl' || type === 'webgl2') {
              console.log(prefix, `canvas.getContext(${type}) ->`, !!ctx);
              const proto = Object.getPrototypeOf(ctx || {});
              if (proto && proto.getParameter) {
                const origGetParam = proto.getParameter;
                proto.getParameter = function (param) {
                  const val = origGetParam.call(this, param);
                  try { console.log(prefix, `WebGL getParameter(${param}) ->`, val); } catch {}
                  return val;
                };
              }
              if (proto && proto.getExtension) {
                const origGetExt = proto.getExtension;
                proto.getExtension = function (name) {
                  const val = origGetExt.call(this, name);
                  try { console.log(prefix, `WebGL getExtension(${name}) ->`, !!val); } catch {}
                  return val;
                };
              }
            }
          } catch (e) {}
          return ctx;
        };
      } catch (e) {}
    });

    // --- Audio & DOM insertion hooks (detect <audio> injection + play) ---
    safeRun(() => {
      (function () {
        const aprefix = prefix + '-AUDIO';
        try {
          const origCreate = Document.prototype.createElement;
          Document.prototype.createElement = function (tagName, options) {
            const el = origCreate.call(this, tagName, options);
            try { if (String(tagName).toLowerCase() === 'audio') { console.log(aprefix, 'createElement(audio) -> element created', el); } } catch (e) {}
            return el;
          };
        } catch (e) {}
        try {
          const origSetAttr = Element.prototype.setAttribute;
          Element.prototype.setAttribute = function (name, value) {
            try { if (this.tagName && this.tagName.toLowerCase() === 'audio' && String(name).toLowerCase() === 'src') { console.log(aprefix, 'setAttribute src on <audio> ->', value); } } catch (e) {}
            return origSetAttr.apply(this, arguments);
          };
        } catch (e) {}
        try {
          const proto = HTMLMediaElement && HTMLMediaElement.prototype;
          if (proto) {
            const desc = Object.getOwnPropertyDescriptor(proto, 'src');
            if (desc && desc.configurable && desc.get && desc.set) {
              const origGet = desc.get;
              const origSet = desc.set;
              Object.defineProperty(proto, 'src', {
                configurable: true,
                get() { try { const v = origGet.call(this); console.log(aprefix, 'audio.src read ->', v); return v; } catch (e) { return origGet && origGet.call(this); } },
                set(v) { try { console.log(aprefix, 'audio.src set ->', v); } catch (e) {} return origSet.call(this, v); }
              });
            }
          }
        } catch (e) {}
        try {
          const mediaProto = HTMLMediaElement && HTMLMediaElement.prototype;
          if (mediaProto && mediaProto.play) {
            const origPlay = mediaProto.play;
            mediaProto.play = function (...args) {
              try {
                const src = this.currentSrc || this.src || (this.getAttribute && this.getAttribute('src'));
                console.log(aprefix, 'audio.play called -> src:', src, 'element:', this);
                // Uncomment to capture stack trace (can be very verbose):
                // console.log(new Error('audio.play stack').stack);
              } catch (e) {}
              return origPlay.apply(this, args);
            };
          }
        } catch (e) {}
        try {
          const desc = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
          if (desc && desc.set && desc.configurable) {
            const origSet = desc.set;
            Object.defineProperty(Element.prototype, 'innerHTML', {
              configurable: true,
              get: desc.get,
              set(html) {
                try { if (typeof html === 'string' && html.toLowerCase().includes('<audio')) console.log(aprefix, 'innerHTML set containing <audio> ->', html); } catch (e) {}
                return origSet.call(this, html);
              }
            });
          }
        } catch (e) {}
        try {
          const origInsert = Element.prototype.insertAdjacentHTML;
          Element.prototype.insertAdjacentHTML = function (position, text) {
            try { if (typeof text === 'string' && text.toLowerCase().includes('<audio')) console.log(aprefix, 'insertAdjacentHTML with <audio> ->', position, text); } catch (e) {}
            return origInsert.apply(this, arguments);
          };
        } catch (e) {}
        try {
          const origAppend = Node.prototype.appendChild;
          Node.prototype.appendChild = function (child) {
            try { if (child && child.tagName && child.tagName.toLowerCase() === 'audio') console.log(aprefix, 'appendChild audio element ->', child, 'src:', child.src || (child.getAttribute && child.getAttribute('src'))); } catch (e) {}
            return origAppend.apply(this, arguments);
          };
        } catch (e) {}
        try {
          const mo = new MutationObserver(muts => {
            for (const m of muts) {
              if (m.addedNodes && m.addedNodes.length) {
                m.addedNodes.forEach(node => {
                  try {
                    if (node.nodeType === 1) {
                      if (node.tagName && node.tagName.toLowerCase() === 'audio') {
                        console.log(aprefix, 'MutationObserver: audio added ->', node, 'src:', node.src || (node.getAttribute && node.getAttribute('src')));
                      } else {
                        const aud = node.querySelector && node.querySelector('audio');
                        if (aud) console.log(aprefix, 'MutationObserver: audio inside added node ->', aud, 'src:', aud.src || (aud.getAttribute && aud.getAttribute('src')));
                      }
                    }
                  } catch (e) {}
                });
              }
            }
          });
          mo.observe(document, { childList: true, subtree: true });
        } catch (e) {}
      })();
    });

    // --- fetch() wrapper (logs request and response bodies where possible) ---
    safeRun(() => {
      try {
        const origFetch = window.fetch.bind(window);
        window.fetch = async function (input, init) {
          try {
            let req;
            if (input instanceof Request) {
              req = input;
              if (init) req = new Request(req, init);
            } else {
              req = new Request(input, init);
            }

            const method = req.method;
            const url = req.url;
            const headers = {};
            req.headers.forEach((v, k) => headers[k] = v);

            let reqBody = undefined;
            try {
              if (method !== 'GET' && method !== 'HEAD') {
                const rclone = req.clone();
                try { reqBody = await rclone.text(); } catch (e) {
                  try { const blob = await rclone.blob(); reqBody = `[binary blob, size=${blob.size}]`; } catch (_) { reqBody = '[unreadable request body]'; }
                }
                try { reqBody = JSON.parse(reqBody); } catch (_) {}
              }
            } catch (e) { reqBody = `[error reading request body: ${e && e.message}]`; }

            if (shouldLogUrl(url)) {
              try { console.log(prefix + '-FETCH', 'request ->', { url, method, headers, body: reqBody }); } catch (e) {}
            }

            const response = await origFetch(req);
            let clone = null;
            try { clone = response.clone(); } catch (e) { clone = null; }

            if (clone && shouldLogUrl(response.url)) {
              try {
                const txt = await clone.text();
                let body = txt;
                try { body = JSON.parse(txt); } catch (_) {}
                // convert headers object
                const hdrs = {};
                response.headers.forEach((v, k) => { hdrs[k] = v; });
                try { console.log(prefix + '-FETCH', 'response ->', { url: response.url, status: response.status, headers: hdrs, body }); } catch (e) {}
              } catch (e) {
                try { console.log(prefix + '-FETCH', 'response unreadable ->', { url: response.url, status: response.status, error: e && e.message }); } catch (e) {}
              }
            }

            return response;
          } catch (outerErr) {
            try { console.warn(prefix + '-FETCH', 'fetch wrapper error', outerErr && outerErr.message); } catch (e) {}
            return origFetch(input, init);
          }
        };
      } catch (e) { try { console.warn(prefix + '-FETCH', 'failed to install fetch hook', e && e.message); } catch (e) {} }
    });

    // --- XHR wrapper (logs request body and responseText) ---
    safeRun(() => {
      try {
        const Xproto = XMLHttpRequest.prototype;
        const origOpen = Xproto.open;
        const origSend = Xproto.send;

        Xproto.open = function (method, url, async = true, user, password) {
          try { this.__fp_method = method; this.__fp_url = url; } catch (e) {}
          return origOpen.apply(this, arguments);
        };

        Xproto.send = function (body) {
          try {
            const method = this.__fp_method || (this.method || 'GET');
            const url = this.__fp_url || (this.responseURL || '');
            let reqBody = body;
            try { if (typeof reqBody === 'string') { const j = JSON.parse(reqBody); reqBody = j; } } catch (_) {}
            if (shouldLogUrl(url)) {
              try { console.log(prefix + '-XHR', 'send ->', { url, method, body: reqBody }); } catch (e) {}
            }

            const onLoad = () => {
              try {
                if (shouldLogUrl(url)) {
                  const resp = (this.responseType === '' || this.responseType === 'text') ? this.responseText : `[responseType=${this.responseType}]`;
                  let parsed = resp;
                  try { parsed = JSON.parse(resp); } catch (_) {}
                  try { console.log(prefix + '-XHR', 'response ->', { url, status: this.status, response: parsed }); } catch (e) {}
                }
              } catch (e) {}
            };
            this.addEventListener('load', onLoad);
          } catch (e) { try { console.warn(prefix + '-XHR', 'XHR send wrapper error', e && e.message); } catch (e) {} }
          return origSend.apply(this, arguments);
        };
      } catch (e) { try { console.warn(prefix + '-XHR', 'failed to install XHR hook', e && e.message); } catch (e) {} }
    });

    // --- Network instrumentation (fetch/XHR already) + WebSocket hooking ---
    safeRun(() => {
      try {
        const WS = window.WebSocket;
        window.WebSocket = function (url, protocols) {
          try { console.log(prefix, 'WebSocket connect ->', url); } catch (e) {}
          return new WS(url, protocols);
        };
        Object.keys(WS).forEach(k => { try { window.WebSocket[k] = WS[k]; } catch {} });
        window.WebSocket.prototype = WS.prototype;
      } catch (e) {}
    });

    // --- Eval / Function instrumentation ---
    safeRun(() => {
      try {
        const realEval = window.eval;
        window.eval = function (str) { try { console.log(prefix, 'eval called length ->', typeof str === 'string' ? str.length : typeof str); } catch (e) {} return realEval.call(this, str); };
      } catch (e) {}
      try {
        const RealFunction = Function;
        window.Function = function (...args) { try { console.log(prefix, 'Function constructor called -> args count', args && args.length); } catch (e) {} return RealFunction.apply(this, args); };
      } catch (e) {}
    });

    // --- Sensors & misc heuristics ---
    safeRun(() => {
      try {
        const origAddEventListener = EventTarget.prototype.addEventListener;
        EventTarget.prototype.addEventListener = function (type, listener, opts) {
          if (type && (type === 'deviceorientation' || type === 'devicemotion' || type === 'orientationchange')) {
            console.log(prefix, `addEventListener for sensor event ->`, type);
          }
          return origAddEventListener.call(this, type, listener, opts);
        };
      } catch (e) {}
      try {
        Object.defineProperty(navigator, 'webdriver', {
          configurable: true,
          get() { console.log(prefix, 'navigator.webdriver read ->', false); return false; }
        });
      } catch (e) {}
      hookProp(window, 'devicePixelRatio', 'window');
      hookProp(document.documentElement, 'clientWidth', 'documentElement');
      hookProp(document.documentElement, 'clientHeight', 'documentElement');
    });

    // Mark done
    try { console.log(prefix, 'injection-complete'); } catch (e) {}
  }, URL_FILTER);

  // === Navigate to the page you want to analyze ===
  const target = 'https://www.eticketing.co.uk/tottenhamhotspur/Events';
  await page.goto(target, { waitUntil: 'load' });

  console.log('Page loaded — open DevTools and watch [PAGE] logs for FP-HOOK outputs.');
  console.log('Captured Set-Cookie headers stored in Node arrays: capturedSetCookies / parsedCookies.');

  // Keep running for interactive debugging; remove timeout if you want to keep indefinitely
  // await new Promise(() => {}); // uncomment to keep running forever
  // Or close after some time:
  // await new Promise(res => setTimeout(res, 30000));
  // await browser.close();
})();
