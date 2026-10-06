/*
 * The mobile floor, measured.
 *
 * WHY this is shared: the same floors are held on the public pages (mobile.spec.ts) and inside the
 * signed-in console (console-mobile.spec.ts), and two copies of this measurement would drift — the
 * first version of it read only paragraphs, list items and spans of twelve characters or more,
 * which is how a 10px caption, an 11px table header and the world timeline's 11px tick labels all
 * survived an audit that reported the site as clean.
 */
import type { Page } from "@playwright/test";

/** Text inside these containers is inline prose, where a 40px target is impossible. */
export const PROSE =
  ".prose, .policy-document, .information-main article, p, li, td, dd";

/** Elements that carry text a reader has to read. */
const READABLE =
  "p, li, span, a, small, label, td, th, dt, dd, code, button, strong, em, time, summary";

export interface FloorReport {
  documentOverflow: number;
  overflowing: string[];
  sidewaysNav: string[];
  smallText: string[];
  smallTargets: string[];
  clippedText: string[];
}

export async function floorReport(page: Page): Promise<FloorReport> {
  return page.evaluate(
    ({ prose, readable }) => {
      const viewport = window.innerWidth;
      const scrolls = (el: Element) => {
        for (let node = el.parentElement; node; node = node.parentElement) {
          const style = getComputedStyle(node);
          // A container that scrolls sideways is allowed to hold wide content — a price table on a
          // phone has to. The document itself scrolling sideways is not.
          if (style.overflowX === "auto" || style.overflowX === "scroll")
            return true;
          if (node === document.body) return false;
        }
        return false;
      };
      const label = (el: Element) => {
        const cls =
          typeof el.className === "string" && el.className
            ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".")
            : "";
        return el.tagName.toLowerCase() + cls;
      };
      const ownText = (el: Element) =>
        Array.from(el.childNodes)
          .filter((node) => node.nodeType === 3)
          .map((node) => (node.textContent || "").trim())
          .join("");

      // Visible text must fit the viewport. Decorative art that a container deliberately crops (the
      // landing page's world scenes) and a drawer parked outside the viewport are exempt — the
      // document not scrolling sideways is asserted separately, and a clipped paragraph fails here.
      const overflowing: string[] = [];
      for (const el of Array.from(document.querySelectorAll("body *"))) {
        const rect = el.getBoundingClientRect();
        if (!rect.width || !rect.height) continue;
        const style = getComputedStyle(el);
        if (style.position === "fixed" || style.visibility === "hidden")
          continue;
        if (rect.right <= viewport + 1) continue;
        if (scrolls(el)) continue;
        // A closed <details> paints nothing, so its help text is not on screen to be clipped. It
        // still has a box, which is how an off-screen tooltip stayed invisible until it was opened.
        if (el.closest("details:not([open])")) continue;
        const text = ownText(el);
        if (!text) continue;
        overflowing.push(
          label(el) +
            " right=" +
            Math.round(rect.right) +
            " '" +
            text.slice(0, 24) +
            "'",
        );
      }

      // A section nav that wraps rather than scrolling sideways: the reader can see every section.
      const sidewaysNav: string[] = [];
      for (const nav of Array.from(document.querySelectorAll("nav"))) {
        if (
          nav.scrollWidth > nav.clientWidth + 2 &&
          getComputedStyle(nav).overflowX !== "visible"
        )
          sidewaysNav.push(
            label(nav) + " " + nav.scrollWidth + ">" + nav.clientWidth,
          );
      }

      const smallText: string[] = [];
      for (const el of Array.from(document.querySelectorAll(readable))) {
        if (el.children.length > 0) continue;
        const text = (el.textContent || "").trim();
        // Two characters is deliberate: "01", "t0" and "read" are text a reader reads.
        if (text.length < 2) continue;
        if (el.closest(prose)) continue;
        const size = parseFloat(getComputedStyle(el).fontSize);
        if (size && size < 12)
          smallText.push(
            label(el) + " " + size + "px '" + text.slice(0, 24) + "'",
          );
      }

      const smallTargets: string[] = [];
      for (const el of Array.from(
        document.querySelectorAll("a, button, select, input, summary"),
      )) {
        const type = el.getAttribute("type");
        // A checkbox and a radio are tapped through the label around them, which is the box that
        // has to be big enough.
        const target =
          type === "checkbox" || type === "radio"
            ? (el.closest("label") ?? el)
            : el;
        const rect = target.getBoundingClientRect();
        if (!rect.width || !rect.height) continue;
        if (el.classList.contains("skip")) continue;
        // The exemption is exactly "an anchor that renders inline", which is what the stylesheet
        // makes of a link inside a sentence. It is not "any control inside p/li/td/dd": treating
        // those containers as prose is how a table's action buttons went unchecked — the one place
        // a dense console puts its smallest controls is inside a cell — and how the legal pages'
        // table of contents went unchecked, because it sits inside the prose *container* while
        // being a list of links. An anchor that a flex or grid parent has blockified, or that the
        // stylesheet made inline-flex, is a control and is measured as one.
        if (el.tagName === "A" && getComputedStyle(el).display === "inline")
          continue;
        if (rect.height < 40)
          smallTargets.push(
            label(el) +
              " " +
              Math.round(rect.height) +
              "px '" +
              (el.textContent || el.getAttribute("aria-label") || "")
                .trim()
                .slice(0, 24) +
              "'",
          );
      }

      // Text cut off with an ellipsis is text the reader cannot read, and no size rule catches it.
      // A table cell is exempt: there the ellipsis is the deliberate way to keep a row on one line
      // inside a table that scrolls sideways.
      const clippedText: string[] = [];
      for (const el of Array.from(document.querySelectorAll(readable))) {
        if (el.children.length > 0) continue;
        if (el.closest("table")) continue;
        const text = ownText(el);
        if (text.length < 2) continue;
        if (getComputedStyle(el).textOverflow !== "ellipsis") continue;
        if (el.scrollWidth > el.clientWidth + 1)
          clippedText.push(label(el) + " '" + text.slice(0, 24) + "'");
      }

      return {
        documentOverflow: document.documentElement.scrollWidth - viewport,
        overflowing: [...new Set(overflowing)].slice(0, 6),
        sidewaysNav: [...new Set(sidewaysNav)].slice(0, 6),
        smallText: [...new Set(smallText)].slice(0, 6),
        smallTargets: [...new Set(smallTargets)].slice(0, 6),
        clippedText: [...new Set(clippedText)].slice(0, 6),
      };
    },
    { prose: PROSE, readable: READABLE },
  );
}
