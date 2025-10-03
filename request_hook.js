const puppeteer = require("puppeteer");

(async () => {
  const browser = await puppeteer.launch({
    headless: false, // set true if you don’t want UI
    args: ["--disable-web-security", "--disable-features=IsolateOrigins,site-per-process"]
  });

  const page = await browser.newPage();

  // === Network-level interception ===
  page.on("request", req => {
    console.log("[REQ]", req.method(), req.url());
    if (req.postData()) {
      console.log("  body:", req.postData());
    }
  });

  page.on("response", async res => {
    try {
      const url = res.url();
      const status = res.status();
      let body = "";
      try {
        body = await res.text();
      } catch (e) {
        body = "[unreadable: maybe binary or blocked]";
      }
      console.log("[RES]", status, url, "body:", body.slice(0, 300));
    } catch (e) {
      console.log("[RES error]", e.message);
    }
  });

  // === In-page hooks (evaluateOnNewDocument) ===
  await page.evaluateOnNewDocument(() => {
    const prefix = "FP-HOOK";

    // ---- Fake fingerprint properties ----
    Object.defineProperty(window.screen, "availWidth", {
      get: () => {
        console.log(prefix, "screen.availWidth read");
        return 1920;
      }
    });
    Object.defineProperty(window.screen, "availHeight", {
      get: () => {
        console.log(prefix, "screen.availHeight read");
        return 1080;
      }
    });

    // ---- Document URL & domain spoofing (read-only) ----
    /*const fakeLocation = {
      href: "https://www.example.com/test/page?x=123",
      pathname: "/test/page",
      search: "?x=123",
      hash: "#hooked",
      hostname: "www.example.com",
      host: "www.example.com",
      protocol: "https:"
    };

    Object.defineProperty(document, "URL", {
      configurable: true,
      get() {
        console.log(prefix, "document.URL read ->", fakeLocation.href);
        return fakeLocation.href;
      }
    });

    Object.defineProperty(document, "domain", {
      configurable: true,
      get() {
        console.log(prefix, "document.domain read ->", fakeLocation.hostname);
        return fakeLocation.hostname;
      }
    });

    history.replaceState(
      {},
      "",
      fakeLocation.pathname + fakeLocation.search + fakeLocation.hash
    );
    console.log(prefix, "history.replaceState applied");
*/
    // ---- Fetch & XHR hook for request/response bodies ----
    (function() {
      const fPrefix = "FP-HOOK-FETCH";

      // fetch wrapper
      const origFetch = window.fetch.bind(window);
      window.fetch = async function(input, init) {
        let url = input;
        let method = "GET";
        let body;

        if (input instanceof Request) {
          url = input.url;
          method = input.method;
          try {
            const clone = input.clone();
            body = await clone.text();
          } catch (e) {
            body = "[unreadable]";
          }
        } else {
          if (init) {
            method = init.method || "GET";
            body = init.body;
          }
        }

        console.log(fPrefix, "fetch ->", { url, method, body });
        const res = await origFetch(input, init);

        try {
          const clone = res.clone();
          const txt = await clone.text();
          console.log(fPrefix, "fetch response ->", {
            url: res.url,
            status: res.status,
            body: txt.slice(0, 200)
          });
        } catch (e) {
          console.log(fPrefix, "fetch response unreadable");
        }
        return res;
      };

      // XHR wrapper
      const Xproto = XMLHttpRequest.prototype;
      const origOpen = Xproto.open;
      const origSend = Xproto.send;

      Xproto.open = function(method, url, async = true, user, password) {
        this.__fp_method = method;
        this.__fp_url = url;
        return origOpen.apply(this, arguments);
      };

      Xproto.send = function(body) {
        console.log(fPrefix, "XHR ->", {
          url: this.__fp_url,
          method: this.__fp_method,
          body
        });

        this.addEventListener("load", () => {
          console.log(fPrefix, "XHR response ->", {
            url: this.__fp_url,
            status: this.status,
            response: this.responseText.slice(0, 200)
          });
        });

        return origSend.apply(this, arguments);
      };
    })();
  });

  // === Navigate ===
  await page.goto("https://www.eticketing.co.uk/tottenhamhotspur/Events", { waitUntil: "networkidle2" });
})();
