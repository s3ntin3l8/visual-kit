/**
 * `box` (a viewport-relative bounding box) grown by `margin` on every side,
 * moved into document coordinates with `doc.scrollX/scrollY`, and clamped to the
 * `doc.width` x `doc.height` document. Ported from branchDAM's demo capture.
 */
export function padRect(box, doc, margin = 24) {
  const left = box.x + doc.scrollX - margin;
  const top = box.y + doc.scrollY - margin;
  const right = Math.min(left + box.width + 2 * margin, doc.width);
  const bottom = Math.min(top + box.height + 2 * margin, doc.height);
  const x = Math.max(0, left);
  const y = Math.max(0, top);
  return { x, y, width: right - x, height: bottom - y };
}
