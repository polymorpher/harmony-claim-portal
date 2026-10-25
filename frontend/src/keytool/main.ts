import { bech32ToHex, isBech32Address } from "@hcp/shared";
import { deriveHarmonyKeys, normalizePhrase, phraseProblem, type DerivedKey } from "./derive";

const PAGE = 10;
const SEARCH = 100;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const form = $<HTMLFormElement>("form");
const phraseInput = $<HTMLTextAreaElement>("phrase");
const passphraseInput = $<HTMLInputElement>("passphrase");
const targetInput = $<HTMLInputElement>("target");
const error = $<HTMLParagraphElement>("error");
const results = $<HTMLElement>("results");
const rows = $<HTMLTableSectionElement>("rows");
const more = $<HTMLButtonElement>("more");
const network = $<HTMLDivElement>("network");

let phrase = "";
let passphrase = "";
let shown = 0;
let match: string | null = null;

function showNetwork() {
  if (navigator.onLine) {
    network.className = "banner warn";
    network.textContent = "This computer is online. Disconnect it from the internet before you type your recovery phrase.";
  } else {
    network.className = "banner ok";
    network.textContent = "This computer is offline.";
  }
}

function fail(message: string) {
  error.textContent = message;
  error.hidden = false;
}

function targetAddress(text: string): string | null {
  const value = text.trim();
  if (!value) return null;
  if (/^0x[0-9a-fA-F]{40}$/.test(value)) return value.toLowerCase();
  if (isBech32Address(value)) return bech32ToHex(value).toLowerCase();
  throw new Error("That address is neither a 0x… nor a one1… address.");
}

function cell(...children: (Node | string)[]): HTMLTableCellElement {
  const td = document.createElement("td");
  td.append(...children);
  return td;
}

function code(text: string): HTMLElement {
  const el = document.createElement("code");
  el.textContent = text;
  return el;
}

function button(label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "ghost small";
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

function selectText(el: HTMLElement) {
  const range = document.createRange();
  range.selectNodeContents(el);
  window.getSelection()?.removeAllRanges();
  window.getSelection()?.addRange(range);
}

function keyCell(key: DerivedKey): HTMLTableCellElement {
  const td = cell();
  const reveal = button("Show private key", () => {
    const text = Object.assign(code(key.privateKey), { className: "key" });
    // Opened from a file, some browsers have no clipboard API; then the key is selected for copying by hand.
    const copy = button("Copy", () => {
      if (!navigator.clipboard) {
        selectText(text);
        copy.textContent = "Selected: copy it with Ctrl+C or ⌘C";
        return;
      }
      navigator.clipboard.writeText(key.privateKey).then(
        () => (copy.textContent = "Copied"),
        () => {
          selectText(text);
          copy.textContent = "Selected: copy it with Ctrl+C or ⌘C";
        },
      );
    });
    td.replaceChildren(text, copy, button("Hide", () => td.replaceWith(keyCell(key))));
  });
  td.append(reveal);
  return td;
}

function addRows(keys: DerivedKey[]) {
  for (const key of keys) {
    const tr = document.createElement("tr");
    if (match && key.address.toLowerCase() === match) tr.className = "match";
    const address = cell(code(key.address), document.createElement("br"), code(key.one1));
    const path = document.createElement("div");
    path.className = "small";
    path.textContent = key.path;
    address.append(path);
    tr.append(cell(`#${key.index}`), address, keyCell(key));
    rows.append(tr);
  }
  shown += keys.length;
}

function clearAll() {
  form.reset();
  phrase = "";
  passphrase = "";
  shown = 0;
  match = null;
  rows.replaceChildren();
  results.hidden = true;
  error.hidden = true;
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  error.hidden = true;
  rows.replaceChildren();
  shown = 0;
  const candidate = normalizePhrase(phraseInput.value);
  const problem = phraseProblem(candidate);
  if (problem) return fail(problem);
  try {
    match = targetAddress(targetInput.value);
  } catch (err) {
    return fail((err as Error).message);
  }
  phrase = candidate;
  passphrase = passphraseInput.value;
  let count = PAGE;
  if (match) {
    const found = deriveHarmonyKeys(phrase, passphrase, 0, SEARCH).find((k) => k.address.toLowerCase() === match);
    if (!found) {
      return fail(
        `That address is not among the first ${SEARCH} addresses of this phrase. Check the words and the passphrase; a different passphrase gives entirely different addresses.`,
      );
    }
    count = Math.ceil((found.index + 1) / PAGE) * PAGE;
  }
  addRows(deriveHarmonyKeys(phrase, passphrase, 0, count));
  results.hidden = false;
});

more.addEventListener("click", () => addRows(deriveHarmonyKeys(phrase, passphrase, shown, PAGE)));
$<HTMLButtonElement>("clear").addEventListener("click", clearAll);
// Leave nothing behind in the back/forward cache.
window.addEventListener("pagehide", clearAll);
window.addEventListener("online", showNetwork);
window.addEventListener("offline", showNetwork);
showNetwork();
