import { conversionPercent } from "./parseReport.js"

export const REASON_NOT_AVAILABLE = "Reason not available"
export const UNCLASSIFIED = "UNCLASSIFIED"

function emptyCourse(date, group) {
  return {
    date,
    key: group.key,
    kind: group.kind,
    courseId: group.id ?? null,
    name: group.name,
    totalCalls: 0,
    withTranscript: 0,
    withoutTranscript: 0,
    successful: 0,
    notCompleted: 0,
    unclear: 0,
    conversion: "0.0%",
    reasons: [],
    phones: [],
  }
}

// One course entry per (day, Golf Course ID or Organization ID); unclassified calls form their own entry.
export function buildFlowReports(flow) {
  if (!flow) return []
  const byDay = new Map()
  const courseFor = (dayIndex, groupIndex) => {
    const date = flow.days[dayIndex]
    let courses = byDay.get(date)
    if (!courses) {
      courses = new Map()
      byDay.set(date, courses)
    }
    let course = courses.get(groupIndex)
    if (!course) {
      course = emptyCourse(date, flow.groups[groupIndex])
      courses.set(groupIndex, course)
    }
    return course
  }
  for (const [day, group, phone, total, withTranscript, booked, saved, unknown] of flow.rows) {
    const course = courseFor(day, group)
    course.totalCalls += total
    course.withTranscript += withTranscript
    course.withoutTranscript += total - withTranscript
    course.successful += booked
    course.notCompleted += saved
    course.unclear += unknown
    course.phones.push({ phone: flow.phones[phone], total, withTranscript, booked, saved, unknown })
  }
  for (const [day, group, category, count] of flow.reasons) {
    const course = courseFor(day, group)
    course.reasons.push({
      reason: category >= 0 ? flow.categories[category] : REASON_NOT_AVAILABLE,
      count,
      calls: [],
    })
  }
  return [...byDay.entries()].map(([date, courses]) => ({
    date,
    courses: [...courses.values()].map((course) => ({
      ...course,
      conversion: conversionPercent(course.successful, course.totalCalls),
    })),
  }))
}

export function phoneRows(courses, configuredPhones = []) {
  const byPhone = new Map()
  for (const phone of configuredPhones) {
    byPhone.set(phone, { phone, configured: true, total: 0, withTranscript: 0, booked: 0, saved: 0, unknown: 0 })
  }
  for (const course of courses || []) {
    for (const row of course.phones || []) {
      let entry = byPhone.get(row.phone)
      if (!entry) {
        entry = { phone: row.phone, configured: false, total: 0, withTranscript: 0, booked: 0, saved: 0, unknown: 0 }
        byPhone.set(row.phone, entry)
      }
      entry.total += row.total
      entry.withTranscript += row.withTranscript
      entry.booked += row.booked
      entry.saved += row.saved
      entry.unknown += row.unknown
    }
  }
  return [...byPhone.values()].sort((left, right) => right.total - left.total || left.phone.localeCompare(right.phone))
}

export function callsQuery(params) {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") search.set(key, String(value))
  }
  return `/api/calls?${search.toString()}`
}
