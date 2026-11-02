/* The shared header's two links, carrying who you are across.
 *
 * Both pages start from a username and remember it, but each remembers it in
 * its own storage key, so a bare link from one to the other could land on the
 * start screen and ask again. Instead the link is stamped with the current
 * user and league just before it is followed — and both pages already treat a
 * ?user= link as winning over whatever they last remembered, so it opens on
 * the same person and league you were just looking at.
 *
 * Stamped at the moment of use rather than once on load, because both pages
 * rewrite their address bar as you switch leagues; a link built on load would
 * carry the league you started on. The draft id stays behind: the luck table
 * has no use for it, and the board picks its own.
 */

const CARRY = ["user", "league"];

function stamp(link) {
  const here = new URLSearchParams(location.search);
  const out = new URLSearchParams();
  for (const key of CARRY) if (here.get(key)) out.set(key, here.get(key));
  const page = link.getAttribute("href").split("?")[0];
  link.setAttribute("href", page + (out.toString() ? "?" + out : ""));
}

for (const link of document.querySelectorAll("a[data-nav]")) {
  // pointerdown and focus as well as click, so a middle-click or a
  // long-press "open in new tab" gets the stamped address too.
  for (const event of ["pointerdown", "focus", "click"]) {
    link.addEventListener(event, () => stamp(link));
  }
}
