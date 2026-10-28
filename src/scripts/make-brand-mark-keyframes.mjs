// Prints the @keyframes brand-mark-orbit block for Sidebar.astro. Samples the
// brand figure-8 by arc angle (two r=50 circles) so the comet can animate with
// transform only. Run: node ./src/scripts/make-brand-mark-keyframes.mjs

const RADIUS = 50
const STEPS = 120
// Dots live in a box whose origin is the viewBox origin (8, 58); subtract it here.
const VIEWBOX_ORIGIN_X = 8
const VIEWBOX_ORIGIN_Y = 58

// Forward path arcs: start angle, signed sweep (radians), circle centre.
// Angles use SVG screen space (y down), sweep-flag 1 = increasing angle.
const ARCS = [
  { centreX: 70, centreY: 120, startAngle: 0, sweep: Math.PI },
  { centreX: 70, centreY: 120, startAngle: Math.PI, sweep: Math.PI },
  { centreX: 170, centreY: 120, startAngle: Math.PI, sweep: -Math.PI },
  { centreX: 170, centreY: 120, startAngle: 0, sweep: -Math.PI },
]
const ARC_LENGTH = RADIUS * Math.PI
const TOTAL_LENGTH = ARC_LENGTH * ARCS.length

function forwardPoint(distance) {
  const arcIndex = Math.min(ARCS.length - 1, Math.floor(distance / ARC_LENGTH))
  const arc = ARCS[arcIndex]
  const fraction = (distance - arcIndex * ARC_LENGTH) / ARC_LENGTH
  const angle = arc.startAngle + arc.sweep * fraction
  return {
    x: arc.centreX + RADIUS * Math.cos(angle),
    y: arc.centreY + RADIUS * Math.sin(angle),
  }
}

const lines = ["@keyframes brand-mark-orbit {"]
for (let i = 0; i <= STEPS; i++) {
  // Reverse travel: walk the path backwards, starting at the path start.
  const point = forwardPoint(TOTAL_LENGTH - (i / STEPS) * TOTAL_LENGTH)
  const percent = Number(((i / STEPS) * 100).toFixed(3))
  const x = (point.x - VIEWBOX_ORIGIN_X).toFixed(2)
  const y = (point.y - VIEWBOX_ORIGIN_Y).toFixed(2)
  lines.push(`  ${percent}% { transform: translate(${x}px, ${y}px); }`)
}
lines.push("}")
console.log(lines.join("\n"))
