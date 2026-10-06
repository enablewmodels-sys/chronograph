/*
 * The mobile floor, asserted.
 *
 * WHY this file exists: the stylesheets shrink type and stack layout at narrow widths in more than
 * a hundred places, and several of them made text *smaller* on a phone than on a desktop. Auditing
 * the live site at 390x844 found 7px timeline ticks, an 8px caption, a section nav that scrolled
 * sideways instead of folding, inline links a thumb cannot hit, and a price table cut mid-word. The
 * floors live in ui/src/mobile.css; this holds them, so the next narrow-screen rule cannot quietly
 * cross them again.
 *
 * It runs against the served console rather than a mock of it: the floors are CSS, and CSS is the
 * thing under test. Every page below is a public route, so no session is needed.
 */
import { expect, test, type Page } from "@playwright/test";

// A phone, whatever project this runs under.
test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true });

const PAGES = [
  "/",
  "/bci",
  "/pricing",
  "/login",
  "/signup",
  "/documentation/HOSTED",
  "/privacy",
  "/terms",
  "/support",
  "/status",
];

/** Text a reader has to read, outside the prose containers where inline sizing is deliberate. */
const READABLE = "p, li, span, a, small, label, td, h1, h2, h3, div";
/** A control, as opposed to a link inside a sentence. */
const PROSE = ".prose, .policy-document, .information-main article, p, li, td, dd";

async function floorReport(page: Page) {
  return page.evaluate(
    ({ readable, prose }) => {
      const viewport = window.innerWidth;
      const scrolls = (el: Element) => {
        for (let node = el.parentElement; node; node = node.parentElement) {
          const style = getComputedStyle(node);
          if (style.overflowX === "auto" || style.overflowX === "scroll") return true;
          if (node === document.body) return false;
        }
        return false;
      };
      const label = (el: Element) => {
        const cls = typeof el.className === "string" && el.className ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".") : "";
        return el.tagName.toLowerCase() + cls;
      };

      // Visible text must fit the viewport. Decorative art that a container deliberately crops
      // (the hero's world scenes) is exempt — the document itself not scrolling sideways is
      // asserted separately, and a clipped *paragraph* would fail here.
      const overflowing: string[] = [];
      for (const el of Array.from(document.querySelectorAll("body *"))) {
        const rect = el.getBoundingClientRect();
        if (!rect.width || !rect.height) continue;
        const style = getComputedStyle(el);
        if (style.position === "fixed" || style.visibility === "hidden") continue;
        if (rect.right <= viewport + 1) continue;
        if (scrolls(el)) continue;
        const ownText = Array.from(el.childNodes)
          .filter((node) => node.nodeType === 3)
          .map((node) => (node.textContent || "").trim())
          .join("");
        if (!ownText) continue;
        overflowing.push(label(el) + " right=" + Math.round(rect.right));
      }

      // A section nav that wraps rather than scrolling sideways: the reader can see every section.
      const sidewaysNav: string[] = [];
      for (const nav of Array.from(document.querySelectorAll("nav"))) {
        if (nav.scrollWidth > nav.clientWidth + 2 && getComputedStyle(nav).overflowX !== "visible")
          sidewaysNav.push(label(nav) + " " + nav.scrollWidth + ">" + nav.clientWidth);
      }

      const smallText: string[] = [];
      for (const el of Array.from(document.querySelectorAll(readable))) {
        if (el.children.length > 0) continue;
        const text = (el.textContent || "").trim();
        if (text.length < 12) continue;
        if (el.closest(prose)) continue;
        const size = parseFloat(getComputedStyle(el).fontSize);
        if (size && size < 12) smallText.push(label(el) + " " + size + "px '" + text.slice(0, 24) + "'");
      }

      const smallTargets: string[] = [];
      for (const el of Array.from(document.querySelectorAll("a, button, select"))) {
        const rect = el.getBoundingClientRect();
        if (!rect.width || !rect.height) continue;
        if (el.classList.contains("skip")) continue;
        if (el.closest(prose)) continue;
        if (rect.height < 40)
          smallTargets.push(label(el) + " " + Math.round(rect.height) + "px '" + (el.textContent || "").trim().slice(0, 24) + "'");
      }

      return {
        documentOverflow: document.documentElement.scrollWidth - viewport,
        overflowing: [...new Set(overflowing)].slice(0, 6),
        sidewaysNav: [...new Set(sidewaysNav)].slice(0, 6),
        smallText: [...new Set(smallText)].slice(0, 6),
        smallTargets: [...new Set(smallTargets)].slice(0, 6),
      };
    },
    { readable: READABLE, prose: PROSE },
  );
}

for (const path of PAGES) {
  test(`${path} holds the mobile floor`, async ({ page }) => {
    // The route has to exist before its layout can be judged: a page this deployment does not
    // serve would report every floor at once and mean nothing. A single-page app answers 200 for
    // an unknown route, so the not-found page is recognised by its own heading.
    const response = await page.goto(path);
    await page.waitForTimeout(2000);
    const notFound = await page
      .getByRole("heading", { name: "That page is not here." })
      .isVisible()
      .catch(() => false);
    test.skip(
      notFound || (response !== null && response.status() >= 400),
      `this deployment does not serve ${path}`,
    );
    await expect(page.locator("body")).not.toHaveText(/could not be displayed/);
    const report = await floorReport(page);
    expect(report.documentOverflow, `${path} scrolls sideways: ${JSON.stringify(report)}`).toBeLessThanOrEqual(1);
    expect(report.overflowing, `${path} overflows the viewport: ${JSON.stringify(report.overflowing)}`).toEqual([]);
    expect(
      report.sidewaysNav,
      `${path} has a navigation that scrolls sideways instead of wrapping: ${JSON.stringify(report.sidewaysNav)}`,
    ).toEqual([]);
    expect(report.smallText, `${path} has text below 12px: ${JSON.stringify(report.smallText)}`).toEqual([]);
    expect(report.smallTargets, `${path} has controls below 40px: ${JSON.stringify(report.smallTargets)}`).toEqual([]);
  });
}
