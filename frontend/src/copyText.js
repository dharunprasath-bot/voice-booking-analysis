function courseLines(course, reasonName) {
  const reasons = reasonName
    ? course.reasons.filter((item) => item.reason === reasonName)
    : course.reasons
  const lines = [
    `Course: ${course.name}`,
    `Date: ${course.date}`,
    `Total Calls: ${course.totalCalls}`,
    `Successful Bookings: ${course.successful}`,
    `Booking Not Completed: ${course.notCompleted}`,
    `Unclear Calls: ${course.unclear}`,
    `Conversion: ${course.conversion}`,
    "",
    "Why bookings were not completed:",
    "",
  ]
  if (reasons.length === 0) {
    lines.push("None")
    return lines
  }
  reasons.forEach((reason, index) => {
    lines.push(`${index + 1}. ${reason.reason} – ${reason.calls.length || reason.count}`)
    for (const call of reason.calls) {
      lines.push(`   - Call ID: ${call.callId}`)
      lines.push(`     What happened: ${call.whatHappened || "Not stated"}`)
      lines.push(`     Why not completed: ${call.whyNotCompleted || "Not stated"}`)
    }
    lines.push("")
  })
  return lines
}

export function summaryText(summary) {
  return [
    `Date: ${summary.dateLabel || "All dates"}`,
    `Course: ${summary.courseLabel || "All courses"}`,
    `Failure Reason: ${summary.reasonLabel || "All reasons"}`,
    summary.searchLabel ? `Search: ${summary.searchLabel}` : "",
    `Total Calls: ${summary.totalCalls}`,
    `Successful Bookings: ${summary.successful}`,
    `Booking Not Completed: ${summary.notCompleted}`,
    `Unclear Calls: ${summary.unclear}`,
    `Conversion: ${summary.conversion}`,
    summary.reasonTotalLabel || "",
    summary.coursesAffectedLabel || "",
  ]
    .filter((line) => line !== "")
    .join("\n")
}

export function courseText(course, reasonName) {
  return `${courseLines(course, reasonName).join("\n").trim()}\n`
}

export function reasonText(course, reason) {
  const lines = [
    `Course: ${course.name}`,
    `Date: ${course.date}`,
    `${reason.reason} – ${reason.calls.length || reason.count}`,
    "",
  ]
  for (const call of reason.calls) {
    lines.push(`Call ID: ${call.callId}`)
    lines.push(`What happened: ${call.whatHappened || "Not stated"}`)
    lines.push(`Why not completed: ${call.whyNotCompleted || "Not stated"}`)
    lines.push("")
  }
  return `${lines.join("\n").trim()}\n`
}

export function callText(course, reason, call) {
  return [
    `Course: ${course.name}`,
    `Date: ${course.date}`,
    `Failure Reason: ${reason.reason}`,
    `Call ID: ${call.callId}`,
    `What happened: ${call.whatHappened || "Not stated"}`,
    `Why not completed: ${call.whyNotCompleted || "Not stated"}`,
  ].join("\n")
}

export function filteredText(summary, courses, reasonGroups) {
  const lines = [summaryText(summary), ""]
  if (!courses.length) {
    lines.push("No matching records found.")
    return `${lines.join("\n").trim()}\n`
  }
  lines.push("Courses")
  for (const course of courses) {
    lines.push(
      `${course.name} | ${course.date} | Total Calls: ${course.totalCalls} | Successful Bookings: ${course.successful} | Booking Not Completed: ${course.notCompleted} | Unclear Calls: ${course.unclear} | Conversion: ${course.conversion}`,
    )
  }
  lines.push("", "Failure Reasons")
  for (const group of reasonGroups || []) {
    lines.push("", `${group.reason} — ${group.count}`, `Courses Affected — ${group.courses.length}`)
    for (const course of group.courses) {
      lines.push(`${course.name} — ${course.count}`)
      for (const call of course.calls) {
        lines.push(`Call ID: ${call.callId}`)
        lines.push(`What happened: ${call.whatHappened || "Not stated"}`)
        lines.push(`Why not completed: ${call.whyNotCompleted || "Not stated"}`)
      }
    }
  }
  return `${lines.join("\n").trim()}\n`
}
