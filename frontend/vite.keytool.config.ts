import { createHash } from "node:crypto";
import { defineConfig, type Plugin } from "vite";

// Builds ledger-key-tool.html as one self-contained file that works when saved and opened offline:
// the script is inlined, and the Content-Security-Policy allows that one script (by hash) and
// inline styles, and nothing else, so the page cannot make any network request.
const TOOL = "ledger-key-tool.html";

function selfContained(): Plugin {
  return {
    name: "self-contained-key-tool",
    apply: "build",
    enforce: "post",
    generateBundle(_, bundle) {
      const page = bundle[TOOL];
      if (!page || page.type !== "asset") throw new Error(`${TOOL} was not built`);
      let html = String(page.source);
      for (const [name, chunk] of Object.entries(bundle)) {
        if (chunk.type !== "chunk") continue;
        const tag = new RegExp(`<script type="module"[^>]*src="/${chunk.fileName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*></script>`);
        if (!tag.test(html)) throw new Error(`no script tag for ${chunk.fileName}`);
        const code = chunk.code.replace(/<\/script/gi, "<\\/script");
        const hash = createHash("sha256").update(code).digest("base64");
        const csp =
          `default-src 'none'; script-src 'sha256-${hash}'; style-src 'unsafe-inline'; ` +
          "img-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'";
        html = html
          .replace(tag, () => `<script type="module">${code}</script>`)
          .replace("<!-- content-security-policy -->", `<meta http-equiv="Content-Security-Policy" content="${csp}" />`);
        delete bundle[name];
      }
      if (/<script[^>]+src=|<link[^>]+href=/.test(html)) throw new Error(`${TOOL} still loads another file`);
      page.source = html;
      this.emitFile({ type: "asset", fileName: `${TOOL}.sha256`, source: `${createHash("sha256").update(html).digest("hex")}  ${TOOL}\n` });
    },
  };
}

export default defineConfig({
  plugins: [selfContained()],
  build: {
    outDir: "dist",
    emptyOutDir: false,
    target: "es2022",
    modulePreload: false,
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    rolldownOptions: {
      input: TOOL,
      output: { codeSplitting: false },
    },
  },
});
