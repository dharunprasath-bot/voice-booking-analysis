import { conversionPercent } from "./parseReport.js"

export function safeNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

export function defaultDate(reports) {
  const dates = [...new Set((reports || []).map((report) => report.date).filter(Boolean))].sort().reverse()
  return dates[0] || ""
}

export function coursesForDate(reports, dateFilter) {
  return (reports || [])
    .filter((report) => dateFilter === "all" || report.date === dateFilter)
    .flatMap((report) => report.courses || [])
}

export function datesInRange(dates, from, to) {
  if (!from || !to) return []
  const start = from <= to ? from : to
  const end = from <= to ? to : from
  return [...(dates || [])].filter((date) => date >= start && date <= end).sort()
}

export function coursesForDates(reports, dates) {
  const allowed = new Set(dates || [])
  return (reports || [])
    .filter((report) => allowed.has(report.date))
    .flatMap((report) => report.courses || [])
}

export function percentChange(current, previous) {
  if (previous == null || !Number.isFinite(previous)) return null
  const delta = safeNumber(current) - previous
  if (delta === 0) return { direction: "same", percent: 0 }
  if (previous === 0) return { direction: delta > 0 ? "up" : "down", percent: null }
  return {
    direction: delta > 0 ? "up" : "down",
    percent: (delta / Math.abs(previous)) * 100,
  }
}

export function pointChange(current, previous) {
  if (previous == null || !Number.isFinite(previous)) return null
  const points = safeNumber(current) - previous
  if (Math.abs(points).toFixed(1) === "0.0") return { direction: "same", points: 0 }
  return { direction: points > 0 ? "up" : "down", points: Math.abs(points) }
}

function comparisonRow(date, courses, previous) {
  const summary = summarize(courses)
  const conversion = conversionNumber({
    conversion: summary.conversion,
    successful: summary.successful,
    totalCalls: summary.totalCalls,
  })
  return {
    date,
    ...summary,
    conversionNumber: conversion,
    changes: {
      totalCalls: percentChange(summary.totalCalls, previous?.totalCalls),
      successful: percentChange(summary.successful, previous?.successful),
      notCompleted: percentChange(summary.notCompleted, previous?.notCompleted),
      unclear: percentChange(summary.unclear, previous?.unclear),
      conversion: pointChange(conversion, previous?.conversionNumber),
    },
  }
}

export function compareDays(reports, dates) {
  const ordered = [...(dates || [])].sort()
  let previous = null
  return ordered.map((date) => {
    const row = comparisonRow(date, coursesForDate(reports, date), previous)
    previous = row
    return row
  })
}

export function compareCourseRows(rows) {
  const ordered = [...(rows || [])].sort((left, right) => String(left.date || "").localeCompare(String(right.date || "")))
  let previous = null
  return ordered.map((course) => {
    const row = comparisonRow(course.date, [course], previous)
    previous = row
    return row
  })
}

export function courseNames(courses) {
  return [...new Set(courses.map((course) => course.name).filter(Boolean))].sort((left, right) =>
    left.localeCompare(right),
  )
}

export function reasonNames(courses) {
  const names = new Set()
  for (const course of courses) {
    for (const reason of course.reasons || []) {
      if (reason && reason.reason) names.add(reason.reason)
    }
  }
  return [...names].sort((left, right) => left.localeCompare(right))
}

export function reasonCount(course, reasonName) {
  const match = (course.reasons || []).find((reason) => reason.reason === reasonName)
  return match ? safeNumber(match.count) : 0
}

export function conversionLabel(course) {
  const text = String(course.conversion || "").trim()
  if (text && !text.includes("NaN")) return text
  return conversionPercent(safeNumber(course.successful), safeNumber(course.totalCalls))
}

export function conversionNumber(course) {
  const match = String(course.conversion || "").match(/(\d+(?:\.\d+)?)/)
  if (match) {
    const number = Number(match[1])
    return Number.isFinite(number) ? number : 0
  }
  const totalCalls = safeNumber(course.totalCalls)
  if (!totalCalls) return 0
  return (100 * safeNumber(course.successful)) / totalCalls
}

export function applyFilters(courses, { courseFilter = "all", reasonFilter = "all", search = "" } = {}) {
  const query = String(search || "").trim().toLowerCase()
  const matches = []
  for (const course of courses || []) {
    if (courseFilter !== "all" && course.name !== courseFilter) continue
    if (reasonFilter !== "all" && reasonCount(course, reasonFilter) <= 0) continue
    if (query && !String(course.name || "").toLowerCase().includes(query)) continue
    matches.push(course)
  }
  return matches.sort((left, right) => {
    if (reasonFilter !== "all") {
      const byCount = reasonCount(right, reasonFilter) - reasonCount(left, reasonFilter)
      if (byCount !== 0) return byCount
    }
    const byName = String(left.name || "").localeCompare(String(right.name || ""))
    if (byName !== 0) return byName
    return String(left.date || "").localeCompare(String(right.date || ""))
  })
}

export function aggregateReasons(courses, reasonFilter = "all") {
  const groups = new Map()
  for (const course of courses || []) {
    for (const reason of course.reasons || []) {
      if (!reason || !reason.reason) continue
      if (reasonFilter !== "all" && reason.reason !== reasonFilter) continue
      const count = safeNumber(reason.count)
      const calls = Array.isArray(reason.calls) ? reason.calls : []
      if (count <= 0 && calls.length === 0) continue
      let group = groups.get(reason.reason)
      if (!group) {
        group = { reason: reason.reason, count: 0, courses: [] }
        groups.set(reason.reason, group)
      }
      group.count += count
      group.courses.push({
        date: course.date,
        name: course.name,
        count,
        calls,
      })
    }
  }
  for (const group of groups.values()) {
    group.courses.sort((left, right) => {
      if (right.count !== left.count) return right.count - left.count
      const byName = String(left.name || "").localeCompare(String(right.name || ""))
      if (byName !== 0) return byName
      return String(left.date || "").localeCompare(String(right.date || ""))
    })
  }
  return [...groups.values()].sort((left, right) => {
    if (right.count !== left.count) return right.count - left.count
    return left.reason.localeCompare(right.reason)
  })
}

export function groupCoursesByName(courses) {
  const groups = new Map()
  for (const course of courses || []) {
    if (!course || !course.name) continue
    const rows = groups.get(course.name)
    if (rows) rows.push(course)
    else groups.set(course.name, [course])
  }
  return [...groups.entries()]
    .map(([name, rows]) => {
      const totals = summarize(rows)
      return {
        name,
        ...totals,
        conversionLabel: totals.conversion,
      }
    })
    .sort((left, right) => left.name.localeCompare(right.name))
}

export function summarize(courses) {
  const totalCalls = (courses || []).reduce((sum, course) => sum + safeNumber(course.totalCalls), 0)
  const successful = (courses || []).reduce((sum, course) => sum + safeNumber(course.successful), 0)
  const notCompleted = (courses || []).reduce((sum, course) => sum + safeNumber(course.notCompleted), 0)
  const unclear = (courses || []).reduce((sum, course) => sum + safeNumber(course.unclear), 0)
  return {
    totalCalls,
    successful,
    notCompleted,
    unclear,
    conversion: conversionPercent(successful, totalCalls),
  }
}

export function buildFilteredView(dateCourses, filters) {
  const courses = applyFilters(dateCourses, filters)
  const reasonGroups = aggregateReasons(courses, filters.reasonFilter || "all")
  const summary = summarize(courses)
  const selectedReason =
    filters.reasonFilter && filters.reasonFilter !== "all" ? reasonGroups[0] || null : null
  return { courses, reasonGroups, summary, selectedReason }
}
