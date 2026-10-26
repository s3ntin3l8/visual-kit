import { AxeBuilder } from "@axe-core/playwright";

/** Evaluated in the page: things a reviewer cannot see in a screenshot. */
function inPage() {
  const hasName = (el) => {
    if (el.getAttribute("aria-label")?.trim() || el.getAttribute("title")?.trim()) return true;
    const by = el.getAttribute("aria-labelledby");
    if (by && by.split(/\s+/).some((id) => document.getElementById(id)?.textContent?.trim())) return true;
    // A select's text is its options and a textarea's its initial value: neither is the control's name.
    if (!["SELECT", "TEXTAREA"].includes(el.tagName) && el.textContent?.trim()) return true;
    if (el.tagName === "INPUT" && el.value?.trim()) return true;
    return Boolean(el.querySelector("img[alt]:not([alt=''])"));
  };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
  };
  const controls = [...document.querySelectorAll("button, [role=button], a[href], select, textarea, input:not([type=hidden])")].filter(visible);
  const labelled = (el) => ["INPUT", "SELECT", "TEXTAREA"].includes(el.tagName) && (el.labels?.length || el.getAttribute("placeholder"));
  const unnamed = controls.filter((el) => !hasName(el) && !labelled(el));
  const root = document.documentElement;
  // A control whose right edge is past the viewport is cut off even when the page never scrolls (an
  // `overflow: hidden` ancestor swallows it), which `overflow` alone cannot see. Walking up from the control,
  // the first ancestor that clips decides: a scroller (`auto`/`scroll`) lets the user reach it; a `hidden`/`clip`
  // ancestor whose own right edge the control passes swallows it, even inside a scroller further up. Anything
  // inert or aria-hidden (a closed off-canvas drawer) is not on screen.
  const cutOff = (el) => {
    const right = el.getBoundingClientRect().right;
    if (right <= root.clientWidth + 1) return false;
    for (let p = el.parentElement; p; p = p.parentElement) {
      const o = getComputedStyle(p).overflowX;
      if (o === "auto" || o === "scroll") return false;
      if ((o === "hidden" || o === "clip") && right > p.getBoundingClientRect().right + 1) return true;
    }
    return true;
  };
  const hiddenByAttr = (el) => Boolean(el.closest('[aria-hidden="true"], [inert], [hidden]'));
  const past = controls.filter((el) => cutOff(el) && !hiddenByAttr(el));
  const label = (el) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${el.className && typeof el.className === "string" ? `.${el.className.trim().split(/\s+/)[0]}` : ""}`;
  return {
    overflow: root.scrollWidth > root.clientWidth + 1,
    unnamed: unnamed.length,
    unnamedSample: unnamed.slice(0, 5).map(label),
    offscreen: past.length,
    offscreenSample: past.slice(0, 5).map(label),
  };
}

/** Overflow, unnamed controls and axe violations (rule id, impact, node count) of the page as shot. */
export async function pageMetrics(page) {
  const base = await page.evaluate(inPage);
  const axe = (await new AxeBuilder({ page }).analyze()).violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length }));
  return { ...base, axe };
}
