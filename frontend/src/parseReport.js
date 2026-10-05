const REASON_LINE = /^(\d+)\.\s+(.+?)\s+[–—-]\s+(\d+)\s*$/
const CALL_LINE = /^\s*-\s+Call ID:\s*(.+?)\s*$/
const WHAT_LINE = /^\s*What happened:\s*(.*)$/
const WHY_LINE = /^\s*Why not completed:\s*(.*)$/

function field(block, label) {
  const match = block.match(new RegExp(`^${label}:\\s*(.*)$`, "m"))
  return match ? match[1].trim() : ""
}

function parseCourse(date, block) {
  const name = block.split("\n", 1)[0].trim()
  if (!name) return null
  const reasons = []
  let current = null
  for (const line of block.split("\n")) {
    if (line.startsWith("Repeated Issues:")) break
    const reasonMatch = line.match(REASON_LINE)
    if (reasonMatch) {
      current = {
        reason: reasonMatch[2].trim(),
        count: Number(reasonMatch[3]),
        calls: [],
      }
      reasons.push(current)
      continue
    }
    if (!current) continue
    const callMatch = line.match(CALL_LINE)
    if (callMatch) {
      current.calls.push({
        callId: callMatch[1].trim(),
        whatHappened: "",
        whyNotCompleted: "",
      })
      continue
    }
    const call = current.calls[current.calls.length - 1]
    if (!call) continue
    const whatMatch = line.match(WHAT_LINE)
    if (whatMatch) {
      call.whatHappened = whatMatch[1].trim()
      continue
    }
    const whyMatch = line.match(WHY_LINE)
    if (whyMatch) call.whyNotCompleted = whyMatch[1].trim()
  }
  return {
    date,
    name,
    totalCalls: Number(field(block, "Total Calls")) || 0,
    successful: Number(field(block, "Successful Bookings")) || 0,
    notCompleted: Number(field(block, "Booking Not Completed")) || 0,
    unclear: Number(field(block, "Unclear Calls")) || 0,
    conversion: field(block, "Conversion"),
    reasons,
  }
}

export function parseReport(text, fileName = "") {
  const dateMatch = String(text || "").match(/^Date:\s*(\d{4}-\d{2}-\d{2})/m)
  const fileMatch = String(fileName).match(/(\d{4}-\d{2}-\d{2})/)
  const date = (dateMatch && dateMatch[1]) || (fileMatch && fileMatch[1]) || ""
  const courses = String(text || "")
    .split(/^Course:\s+/m)
    .slice(1)
    .map((block) => parseCourse(date, block))
    .filter(Boolean)
  return { date, fileName, courses }
}

export function conversionPercent(successful, totalCalls) {
  if (!totalCalls) return "0.0%"
  return `${((100 * successful) / totalCalls).toFixed(1)}%`
}
