import { jsPDF } from "jspdf"

const PAGE_WIDTH = 210
const PAGE_HEIGHT = 297
const MARGIN = 16
const FOOTER_Y = 289
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2
const INK = [23, 32, 42]
const MUTED = [82, 96, 109]
const LINE = [221, 226, 232]
const BAND = [243, 244, 246]
const ACCENT = [29, 78, 137]

function plain(value) {
  return String(value ?? "")
    .replace(/\u2013|\u2014/g, "-")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\u2026/g, "...")
    .replace(/\u00a0/g, " ")
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, " ")
    .replace(/[ \t]{2,}/g, " ")
    .trim()
}

export function courseReportFileName(course, reasonFilter) {
  const parts = [course?.name, course?.date]
  if (reasonFilter && reasonFilter !== "all") parts.push(reasonFilter)
  const slug = parts
    .filter(Boolean)
    .join("-")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
  return `${slug || "course-report"}.pdf`
}

export function createCourseReportPdf({ course, summary, reasons, reasonFilter }) {
  const doc = new jsPDF({ unit: "mm", format: "a4" })
  const rows = reasons || []
  let y = 40

  function gapBottom() {
    return FOOTER_Y - 6
  }

  function newPage() {
    doc.addPage()
    y = MARGIN
  }

  function ensure(height) {
    if (y + height > gapBottom()) newPage()
  }

  function setType(size, style, color) {
    doc.setFont("helvetica", style)
    doc.setFontSize(size)
    doc.setTextColor(color[0], color[1], color[2])
  }

  function wrapped(value, width, size) {
    setType(size, "normal", INK)
    return doc.splitTextToSize(plain(value) || " ", width)
  }

  function writeLines(lines, x, size, style, color, leading) {
    setType(size, style, color)
    for (const line of lines) {
      ensure(leading)
      doc.text(line, x, y)
      y += leading
    }
  }

  function sectionTitle(title) {
    ensure(14)
    setType(13, "bold", INK)
    doc.text(title, MARGIN, y)
    y += 2
    doc.setDrawColor(ACCENT[0], ACCENT[1], ACCENT[2])
    doc.setLineWidth(0.5)
    doc.line(MARGIN, y, MARGIN + 32, y)
    y += 7
  }

  doc.setFillColor(ACCENT[0], ACCENT[1], ACCENT[2])
  doc.rect(0, 0, PAGE_WIDTH, 28, "F")
  setType(16, "bold", [255, 255, 255])
  doc.text("Course booking report", MARGIN, 13)
  setType(10, "normal", [255, 255, 255])
  doc.text(plain(course.date || "All dates"), MARGIN, 21)

  writeLines(wrapped(course.name, CONTENT_WIDTH, 18), MARGIN, 18, "bold", INK, 8)
  y += 1
  const reasonLabel = !reasonFilter || reasonFilter === "all" ? "All reasons" : plain(reasonFilter)
  writeLines([`Failure reason: ${reasonLabel}`], MARGIN, 11, "normal", MUTED, 6)
  y += 4

  sectionTitle("Summary")
  const metrics = [
    ["Total Calls", summary?.totalCalls ?? 0],
    ["Successful Bookings", summary?.successful ?? 0],
    ["Booking Not Completed", summary?.notCompleted ?? 0],
    ["Unclear", summary?.unclear ?? 0],
    ["Conversion %", summary?.conversion ?? "0.0%"],
  ]
  const columnWidth = CONTENT_WIDTH / metrics.length
  setType(8, "normal", MUTED)
  const labelLines = metrics.map(([label]) => doc.splitTextToSize(label, columnWidth - 4))
  const headerHeight = Math.max(...labelLines.map((lines) => lines.length)) * 3.6 + 4
  ensure(headerHeight + 12)
  doc.setFillColor(BAND[0], BAND[1], BAND[2])
  doc.rect(MARGIN, y, CONTENT_WIDTH, headerHeight, "F")
  labelLines.forEach((lines, index) => {
    doc.text(lines, MARGIN + index * columnWidth + 2, y + 4.5)
  })
  y += headerHeight
  setType(12, "bold", INK)
  metrics.forEach(([, value], index) => {
    doc.text(plain(value), MARGIN + index * columnWidth + 2, y + 7)
  })
  y += 12
  doc.setDrawColor(LINE[0], LINE[1], LINE[2])
  doc.setLineWidth(0.2)
  doc.line(MARGIN, y, MARGIN + CONTENT_WIDTH, y)
  y += 8

  sectionTitle("Failure reasons")
  if (!rows.length) {
    writeLines(["No matching records found."], MARGIN, 11, "normal", MUTED, 6)
  } else {
    const countWidth = 24
    const reasonWidth = CONTENT_WIDTH - countWidth
    function reasonHeader() {
      ensure(9)
      doc.setFillColor(BAND[0], BAND[1], BAND[2])
      doc.rect(MARGIN, y - 4, CONTENT_WIDTH, 8, "F")
      setType(10, "bold", INK)
      doc.text("Failure reason", MARGIN + 2, y)
      doc.text("Count", MARGIN + reasonWidth, y)
      y += 6
    }
    reasonHeader()
    for (const reason of rows) {
      const nameLines = wrapped(reason.reason, reasonWidth - 4, 10)
      const rowHeight = nameLines.length * 5 + 2
      if (y + rowHeight > gapBottom()) {
        newPage()
        reasonHeader()
      }
      setType(10, "normal", INK)
      doc.text(nameLines, MARGIN + 2, y)
      doc.text(String(reason.count ?? reason.calls?.length ?? 0), MARGIN + reasonWidth, y)
      y += nameLines.length * 5
      doc.setDrawColor(LINE[0], LINE[1], LINE[2])
      doc.line(MARGIN, y - 1, MARGIN + CONTENT_WIDTH, y - 1)
      y += 3
    }
  }
  y += 4

  sectionTitle("Call details")
  if (!rows.length) {
    writeLines(["No matching records found."], MARGIN, 11, "normal", MUTED, 6)
  } else {
    for (const reason of rows) {
      const count = reason.count ?? reason.calls?.length ?? 0
      writeLines(wrapped(`${reason.reason} - ${count}`, CONTENT_WIDTH, 12), MARGIN, 12, "bold", ACCENT, 6)
      y += 1
      const calls = reason.calls || []
      if (!calls.length) {
        writeLines(["No call details."], MARGIN, 10, "normal", MUTED, 5)
        y += 2
        continue
      }
      for (const call of calls) {
        const idLines = wrapped(`Call ID: ${call.callId || "Not stated"}`, CONTENT_WIDTH, 10)
        const whatLines = wrapped(`What happened: ${call.whatHappened || "Not stated"}`, CONTENT_WIDTH, 10)
        const whyLines = wrapped(`Why not completed: ${call.whyNotCompleted || "Not stated"}`, CONTENT_WIDTH, 10)
        writeLines(idLines, MARGIN, 10, "bold", INK, 4.8)
        writeLines(whatLines, MARGIN, 10, "normal", MUTED, 4.6)
        writeLines(whyLines, MARGIN, 10, "normal", MUTED, 4.6)
        y += 1
        ensure(3)
        doc.setDrawColor(LINE[0], LINE[1], LINE[2])
        doc.setLineWidth(0.2)
        doc.line(MARGIN, y, MARGIN + CONTENT_WIDTH, y)
        y += 4
      }
      y += 2
    }
  }

  const pageCount = doc.getNumberOfPages()
  const footer = `${plain(course.name)}  |  ${plain(course.date)}`
  for (let page = 1; page <= pageCount; page += 1) {
    doc.setPage(page)
    doc.setDrawColor(LINE[0], LINE[1], LINE[2])
    doc.setLineWidth(0.2)
    doc.line(MARGIN, FOOTER_Y - 4, PAGE_WIDTH - MARGIN, FOOTER_Y - 4)
    setType(8, "normal", MUTED)
    doc.text(footer, MARGIN, FOOTER_Y)
    const pageLabel = `${page} of ${pageCount}`
    doc.text(pageLabel, PAGE_WIDTH - MARGIN - doc.getTextWidth(pageLabel), FOOTER_Y)
  }

  return doc
}

export function downloadCourseReport(report) {
  createCourseReportPdf(report).save(courseReportFileName(report.course, report.reasonFilter))
}
