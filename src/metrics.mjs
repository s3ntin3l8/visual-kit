import { AxeBuilder } from "@axe-core/playwright";

/** Evaluated in the page: things a reviewer cannot see in a screenshot. */
function inPage() {
  const hasName = (el) => {
    if (el.getAttribute("aria-label")?.trim() || el.getAttribute("title")?.trim()) return true;
    const by = el.getAttribute("aria-labelledby");
    if (by && by.split(/\s+/).some((id) => document.getElementById(id)?.textContent?.trim())) return true;
    if (el.textContent?.trim()) return true;
    if (el.tagName === "INPUT" && el.value?.trim()) return true;
    return Boolean(el.querySelector("img[alt]:not([alt=''])"));
  };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
  };
  const controls = [...document.querySelectorAll("button, [role=button], a[href], input:not([type=hidden])")].filter(visible);
  const labelled = (el) => el.tagName === "INPUT" && (el.labels?.length || el.getAttribute("placeholder"));
  const unnamed = controls.filter((el) => !hasName(el) && !labelled(el));
  const root = document.documentElement;
  return {
    overflow: root.scrollWidth > root.clientWidth + 1,
    unnamed: unnamed.length,
    unnamedSample: unnamed.slice(0, 5).map((el) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${el.className && typeof el.className === "string" ? `.${el.className.trim().split(/\s+/)[0]}` : ""}`),
  };
}

/** Overflow, unnamed controls and axe violations (rule id, impact, node count) of the page as shot. */
export async function pageMetrics(page) {
  const base = await page.evaluate(inPage);
  const axe = (await new AxeBuilder({ page }).analyze()).violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length }));
  return { ...base, axe };
}
