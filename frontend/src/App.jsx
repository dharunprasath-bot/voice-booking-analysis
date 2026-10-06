import { useEffect, useMemo, useRef, useState } from "react"
import { Charts, TrendChart } from "./Charts.jsx"
import { downloadCourseReport } from "./courseReportPdf.js"
import { callText, courseText, filteredText, reasonText, summaryText } from "./copyText.js"
import {
  aggregateReasons,
  applyFilters,
  buildFilteredView,
  compareCourseRows,
  compareDays,
  conversionLabel,
  coursesForDate,
  coursesForDates,
  datesInRange,
  groupCoursesByName,
  reasonNames,
  summarize,
} from "./filterReport.js"
import { parseReport } from "./parseReport.js"

function courseKey(course) {
  return `${course.date}|${course.name}`
}

export default function App() {
  const [reports, setReports] = useState([])
  const [dates, setDates] = useState([])
  const [status, setStatus] = useState("Loading saved reports…")
  const [copyMessage, setCopyMessage] = useState("")
  const [loading, setLoading] = useState(true)
  const [listReady, setListReady] = useState(false)
  const loadedDates = useRef(new Set())
  const [dateFilter, setDateFilter] = useState("")
  const [rangeFrom, setRangeFrom] = useState("")
  const [rangeTo, setRangeTo] = useState("")
  const [compareFrom, setCompareFrom] = useState("")
  const [compareTo, setCompareTo] = useState("")
  const [dailyFrom, setDailyFrom] = useState("")
  const [dailyTo, setDailyTo] = useState("")
  const [courseSearch, setCourseSearch] = useState("")
  const [reasonFilter, setReasonFilter] = useState("all")
  const [page, setPage] = useState("overview")
  const [selectedCourse, setSelectedCourse] = useState(null)
  const [openReasons, setOpenReasons] = useState({})
  const [openCalls, setOpenCalls] = useState({})
  const [copiedId, setCopiedId] = useState("")

  useEffect(() => {
    let cancelled = false
    async function loadList() {
      try {
        const response = await fetch("/api/reports")
        const body = await response.json().catch(() => ({}))
        if (!response.ok || !Array.isArray(body.reports)) throw new Error("list")
        const found = [
          ...new Set(
            body.reports
              .map((name) => {
                const match = /^courses-(\d{4}-\d{2}-\d{2})\.txt$/.exec(String(name))
                return match ? match[1] : ""
              })
              .filter(Boolean),
          ),
        ].sort().reverse()
        if (cancelled) return
        const oldest = found[found.length - 1] || ""
        const newest = found[0] || ""
        setDates(found)
        setDateFilter((current) => current || newest)
        setCompareFrom((current) => current || oldest)
        setCompareTo((current) => current || newest)
        setDailyFrom((current) => current || oldest)
        setDailyTo((current) => current || newest)
        setListReady(true)
        if (!found.length) {
          setStatus("No saved reports yet.")
          setLoading(false)
        }
      } catch {
        if (!cancelled) {
          setStatus("Unable to load report. Please try again.")
          setLoading(false)
        }
      }
    }
    loadList()
    return () => {
      cancelled = true
    }
  }, [])

  const activeDates = useMemo(() => {
    if (!dateFilter) return []
    if (dateFilter === "all") return [...dates].sort()
    if (dateFilter === "range") return datesInRange(dates, rangeFrom, rangeTo)
    return dates.includes(dateFilter) ? [dateFilter] : []
  }, [dates, dateFilter, rangeFrom, rangeTo])

  const dateCourses = useMemo(() => coursesForDates(reports, activeDates), [reports, activeDates])

  const comparisonDates = useMemo(
    () => datesInRange(dates, compareFrom, compareTo),
    [dates, compareFrom, compareTo],
  )

  const comparisonDays = useMemo(() => compareDays(reports, comparisonDates), [reports, comparisonDates])

  const rangeLabel = useMemo(() => dateScopeLabel(dateFilter, rangeFrom, rangeTo), [dateFilter, rangeFrom, rangeTo])

  const overview = useMemo(() => {
    const view = buildFilteredView(dateCourses, { courseFilter: "all", reasonFilter: "all", search: "" })
    return {
      ...view,
      courses: view.courses.map(withConversion),
    }
  }, [dateCourses])

  const allCourses = useMemo(() => coursesForDate(reports, "all"), [reports])

  const listedCourses = useMemo(() => {
    const matched = applyFilters(dateCourses, { courseFilter: "all", reasonFilter: "all", search: courseSearch })
    return groupCoursesByName(matched)
  }, [dateCourses, courseSearch])

  const detailRows = useMemo(() => {
    if (!selectedCourse || !dateFilter) return []
    const allowed = new Set(activeDates)
    return allCourses.filter((course) => course.name === selectedCourse.name && allowed.has(course.date))
  }, [allCourses, selectedCourse, activeDates])

  const dailyDates = useMemo(
    () => datesInRange(dates, dailyFrom, dailyTo),
    [dates, dailyFrom, dailyTo],
  )

  const neededKey = useMemo(() => {
    return [...new Set([...activeDates, ...comparisonDates, ...dailyDates])].sort().join(",")
  }, [activeDates, comparisonDates, dailyDates])

  const courseComparisonDays = useMemo(() => {
    if (!selectedCourse) return []
    const allowed = new Set(dailyDates)
    const rows = allCourses.filter((course) => course.name === selectedCourse.name && allowed.has(course.date))
    return compareCourseRows(rows)
  }, [allCourses, selectedCourse, dailyDates])

  useEffect(() => {
    if (!listReady) return
    const missing = neededKey ? neededKey.split(",").filter((date) => date && !loadedDates.current.has(date)) : []
    if (!missing.length) {
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    async function loadMissing() {
      try {
        const loaded = []
        for (const date of missing) {
          const name = `courses-${date}.txt`
          const response = await fetch(`/api/reports?name=${encodeURIComponent(name)}`)
          const body = await response.json().catch(() => ({}))
          if (!response.ok || typeof body.text !== "string") throw new Error("file")
          const report = parseReport(body.text, body.name || name)
          if (report.date !== date) throw new Error("file")
          loaded.push(report)
        }
        if (cancelled) return
        for (const report of loaded) loadedDates.current.add(report.date)
        setReports((current) => {
          const byDate = new Map(current.map((report) => [report.date, report]))
          for (const report of loaded) byDate.set(report.date, report)
          return [...byDate.values()]
        })
        setStatus("")
        setLoading(false)
      } catch {
        if (!cancelled) {
          setStatus("Unable to load report. Please try again.")
          setLoading(false)
        }
      }
    }
    loadMissing()
    return () => {
      cancelled = true
    }
  }, [listReady, neededKey])

  const detail = useMemo(() => {
    if (!detailRows.length) {
      return { course: null, summary: summarize([]), reasonGroups: [], reasons: [] }
    }
    const summary = summarize(detailRows)
    const reasonGroups = aggregateReasons(detailRows, reasonFilter)
    const reasons = reasonGroups.map((group) => ({
      reason: group.reason,
      count: group.count,
      calls: group.courses.flatMap((course) => course.calls),
    }))
    const course = {
      name: selectedCourse.name,
      date: rangeLabel,
      ...summary,
      conversionLabel: summary.conversion,
      reasons,
    }
    return { course, summary, reasonGroups, reasons }
  }, [detailRows, reasonFilter, selectedCourse, rangeLabel])

  const overviewSummary = useMemo(
    () => ({
      dateLabel: rangeLabel,
      courseLabel: "",
      reasonLabel: "",
      searchLabel: "",
      ...overview.summary,
    }),
    [overview, rangeLabel],
  )

  const detailSummary = useMemo(
    () => ({
      dateLabel: detail.course?.date || rangeLabel,
      courseLabel: detail.course?.name || selectedCourse?.name || "",
      reasonLabel: reasonFilter === "all" ? "" : reasonFilter,
      searchLabel: "",
      ...detail.summary,
      reasonTotalLabel: detail.reasonGroups.length === 1 ? `${detail.reasonGroups[0].reason}: ${detail.reasonGroups[0].count}` : "",
      coursesAffectedLabel: "",
    }),
    [detail, dateFilter, reasonFilter, selectedCourse],
  )

  const detailReasonOptions = useMemo(() => {
    const names = reasonNames(detailRows)
    if (reasonFilter !== "all" && !names.includes(reasonFilter)) {
      return [...names, reasonFilter].sort((left, right) => left.localeCompare(right))
    }
    return names
  }, [detailRows, reasonFilter])

  const ready = !loading && !status

  useEffect(() => {
    if (!dates.length) return
    setCompareFrom((current) => current || dates[dates.length - 1])
    setCompareTo((current) => current || dates[0])
    setDailyFrom((current) => current || dates[dates.length - 1])
    setDailyTo((current) => current || dates[0])
  }, [dates])

  useEffect(() => {
    setCopiedId("")
    setCopyMessage("")
  }, [dateFilter, rangeFrom, rangeTo, reasonFilter, courseSearch, page, selectedCourse])

  function changeDate(value) {
    setDateFilter(value)
    if (value === "range") {
      setRangeFrom((current) => current || dates[dates.length - 1] || "")
      setRangeTo((current) => current || dates[0] || "")
    }
  }

  function clearReasonFilter() {
    setReasonFilter("all")
    setOpenReasons({})
    setOpenCalls({})
    setCopiedId("")
    setCopyMessage("")
  }

  function openCourse(course) {
    setSelectedCourse({ name: course.name })
    setPage("detail")
    setOpenReasons({})
    setOpenCalls({})
  }

  function copy(id, text) {
    const area = document.createElement("textarea")
    area.value = text
    area.setAttribute("readonly", "")
    area.style.position = "fixed"
    area.style.top = "0"
    area.style.left = "0"
    area.style.opacity = "0"
    document.body.appendChild(area)
    area.focus()
    area.select()
    area.setSelectionRange(0, area.value.length)
    let copied = false
    try {
      copied = document.execCommand("copy")
    } catch {
      copied = false
    } finally {
      area.remove()
    }
    if (!copied && navigator.clipboard?.writeText) {
      Promise.race([
        navigator.clipboard.writeText(text),
        new Promise((_, reject) => {
          window.setTimeout(() => reject(new Error("timeout")), 400)
        }),
      ]).then(
        () => showCopied(id),
        () => setCopyMessage("Could not copy. Select the text and press Command-C."),
      )
      return
    }
    if (!copied) {
      setCopyMessage("Could not copy. Select the text and press Command-C.")
      return
    }
    showCopied(id)
  }

  function showCopied(id) {
    setCopyMessage("")
    setCopiedId(id)
    window.setTimeout(() => {
      setCopiedId((current) => (current === id ? "" : current))
    }, 1600)
  }

  return (
    <main data-page={page}>
      <header>
        <div>
          <h1>Course booking reports</h1>
          <p>
            {page === "overview" ? "Overall dashboard" : page === "courses" ? "Course list" : "Course detail"}
          </p>
        </div>
        {page === "overview" ? (
          <CopyButton
            id="filtered"
            label="Copy filtered report"
            copiedId={copiedId}
            disabled={!ready || overview.courses.length === 0}
            onCopy={() => copy("filtered", filteredText(overviewSummary, overview.courses, overview.reasonGroups))}
          />
        ) : null}
        {page === "detail" && detail.course ? (
          <CopyButton
            id="filtered"
            label="Copy filtered report"
            copiedId={copiedId}
            onCopy={() =>
              copy(
                "filtered",
                filteredText(detailSummary, [detail.course], detail.reasonGroups),
              )
            }
          />
        ) : null}
      </header>

      <section className={`filters overview-filters${dateFilter === "range" ? " range-filters" : ""}`} aria-label="Report filters">
        <label>
          Date
          <select
            value={dateFilter || ""}
            onChange={(event) => changeDate(event.target.value)}
            disabled={!dates.length}
          >
            {!dateFilter ? <option value="">Loading dates…</option> : null}
            <option value="all">All dates</option>
            <option value="range">Custom range</option>
            {dates.map((date) => (
              <option key={date} value={date}>
                {date}
              </option>
            ))}
          </select>
        </label>
        {dateFilter === "range" ? (
          <>
            <label>
              From date
              <input
                type="date"
                value={rangeFrom}
                min={dates[dates.length - 1] || ""}
                max={dates[0] || ""}
                onChange={(event) => setRangeFrom(event.target.value)}
              />
            </label>
            <label>
              To date
              <input
                type="date"
                value={rangeTo}
                min={dates[dates.length - 1] || ""}
                max={dates[0] || ""}
                onChange={(event) => setRangeTo(event.target.value)}
              />
            </label>
          </>
        ) : null}
      </section>

      {page === "overview" ? null : (
        <div className="sticky-bar">
          <button
            type="button"
            className="back"
            onClick={() => setPage(page === "detail" ? "courses" : "overview")}
          >
            {page === "detail" ? "Back to Course List" : "Back to Dashboard"}
          </button>
          <p className="sticky-date">{rangeLabel}</p>
          {page === "detail" ? (
            <button type="button" className="clear" onClick={clearReasonFilter}>
              Clear filter
            </button>
          ) : null}
        </div>
      )}

      <p className="status" role="status">
        {status || copyMessage}
      </p>

      {ready && page === "overview" ? (
        <Overview
          summary={overviewSummary}
          courses={overview.courses}
          reasonGroups={overview.reasonGroups}
          copiedId={copiedId}
          onCopy={copy}
          comparisonDays={comparisonDays}
          compareFrom={compareFrom}
          compareTo={compareTo}
          earliestDate={dates[dates.length - 1] || ""}
          latestDate={dates[0] || ""}
          onCompareFrom={setCompareFrom}
          onCompareTo={setCompareTo}
          onOpenCourses={() => setPage("courses")}
        />
      ) : null}

      {ready && page === "courses" ? (
        <CourseList
          courses={listedCourses}
          search={courseSearch}
          onSearch={setCourseSearch}
          onOpenCourse={openCourse}
        />
      ) : null}

      {ready && page === "detail" ? (
        <CourseDetail
          course={detail.course}
          summary={detail.summary}
          reasons={detail.reasons}
          reasonGroups={detail.reasonGroups}
          reasonFilter={reasonFilter}
          reasonOptions={detailReasonOptions}
          openReasons={openReasons}
          openCalls={openCalls}
          copiedId={copiedId}
          onReasonChange={setReasonFilter}
          onToggleReason={(key) => setOpenReasons((current) => ({ ...current, [key]: !current[key] }))}
          onToggleCall={(key) => setOpenCalls((current) => ({ ...current, [key]: !current[key] }))}
          dailyComparison={courseComparisonDays}
          dailyFrom={dailyFrom}
          dailyTo={dailyTo}
          earliestDate={dates[dates.length - 1] || ""}
          latestDate={dates[0] || ""}
          onDailyFrom={setDailyFrom}
          onDailyTo={setDailyTo}
          onCopy={copy}
          onDownload={() => {
            if (!detail.course) return
            downloadCourseReport({
              course: detail.course,
              summary: detail.summary,
              reasons: detail.reasons,
              reasonFilter,
            })
          }}
        />
      ) : null}
    </main>
  )
}

function dateScopeLabel(dateFilter, rangeFrom, rangeTo) {
  if (dateFilter === "all") return "All dates"
  if (dateFilter === "range") {
    if (!rangeFrom || !rangeTo) return "Custom range"
    const start = rangeFrom <= rangeTo ? rangeFrom : rangeTo
    const end = rangeFrom <= rangeTo ? rangeTo : rangeFrom
    return start === end ? start : `${start} to ${end}`
  }
  return dateFilter || ""
}

function withConversion(course) {
  return { ...course, conversionLabel: conversionLabel(course) }
}

function changeText(change) {
  if (!change) return { text: "Baseline", direction: "none" }
  if (change.direction === "same") return { text: "No change", direction: "same" }
  if (change.percent == null) return { text: change.direction === "up" ? "Up" : "Down", direction: change.direction }
  const amount = `${Math.abs(change.percent).toFixed(1)}%`
  return { text: change.direction === "up" ? `Up ${amount}` : `Down ${amount}`, direction: change.direction }
}

function pointText(change) {
  if (!change) return { text: "Baseline", direction: "none" }
  if (change.direction === "same") return { text: "No change", direction: "same" }
  const amount = `${change.points.toFixed(1)} percentage points`
  return { text: change.direction === "up" ? `↑ ${amount}` : `↓ ${amount}`, direction: change.direction }
}

function Overview({
  summary,
  courses,
  reasonGroups,
  comparisonDays,
  compareFrom,
  compareTo,
  earliestDate,
  latestDate,
  onCompareFrom,
  onCompareTo,
  copiedId,
  onCopy,
  onOpenCourses,
}) {
  return (
    <>
      <section className="summary" aria-label="Overall summary">
        <div className="summary-head">
          <h2>Summary</h2>
          <div className="summary-actions">
            <button type="button" className="view active" onClick={onOpenCourses}>
              Course List
            </button>
            <CopyButton
              id="summary"
              label="Copy summary"
              copiedId={copiedId}
              disabled={courses.length === 0}
              onCopy={() => onCopy("summary", summaryText(summary))}
            />
          </div>
        </div>
        <SummaryCards summary={summary} />
      </section>
      {courses.length ? (
        <Charts summary={summary} reasonGroups={reasonGroups} courses={courses} />
      ) : (
        <p className="empty">No matching records found.</p>
      )}
      <DateComparison
        days={comparisonDays}
        from={compareFrom}
        to={compareTo}
        earliestDate={earliestDate}
        latestDate={latestDate}
        onFrom={onCompareFrom}
        onTo={onCompareTo}
      />
    </>
  )
}

function DateComparison({
  days,
  from,
  to,
  earliestDate,
  latestDate,
  onFrom,
  onTo,
  title = "Date comparison",
  note = "Each day compared with the previous day in this range. Counts show percentage change. Conversion shows percentage-point change.",
  controls = true,
  courseName = "",
}) {
  const metrics = [
    ["totalCalls", "Total Calls"],
    ["successful", "Successful Bookings"],
    ["notCompleted", "Booking Not Completed"],
    ["unclear", "Unclear Calls"],
    ["conversion", "Conversion %"],
  ]
  return (
    <section className="chart" aria-label={title} data-course={courseName || undefined}>
      <h3>{title}</h3>
      <p className="chart-note">{note}</p>
      {controls ? <div className="filters range-filters comparison-filters">
        <label>
          From date
          <input type="date" value={from} min={earliestDate} max={latestDate} onChange={(event) => onFrom(event.target.value)} />
        </label>
        <label>
          To date
          <input type="date" value={to} min={earliestDate} max={latestDate} onChange={(event) => onTo(event.target.value)} />
        </label>
      </div> : null}
      {days.length ? <TrendChart days={days} /> : <p className="empty">No matching records found.</p>}
      {days.length ? <div className="comparison-scroll">
        <table className="comparison">
          <thead>
            <tr>
              <th>Date</th>
              {metrics.map(([, label]) => (
                <th key={label}>{label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {days.map((day) => (
              <tr key={day.date}>
                <td>{day.date}</td>
                {metrics.map(([key]) => {
                  const change = key === "conversion" ? pointText(day.changes[key]) : changeText(day.changes[key])
                  const value = key === "conversion" ? day.conversion : day[key]
                  return (
                    <td key={key}>
                      <strong>{value}</strong>
                      <span className={`change ${change.direction}`}>{change.text}</span>
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div> : null}
    </section>
  )
}

function CourseDailyComparison({ courseName, days, from, to, earliestDate, latestDate, onFrom, onTo }) {
  const metrics = [
    ["totalCalls", "Total Calls"],
    ["successful", "Successful Bookings"],
    ["notCompleted", "Booking Not Completed"],
    ["unclear", "Unclear"],
    ["conversion", "Conversion %"],
  ]
  return (
    <section className="chart" aria-label="Daily Comparison" data-course={courseName}>
      <h3>Daily Comparison</h3>
      <p className="chart-note">{courseName} only. This range is separate from the date filter.</p>
      <div className="filters range-filters comparison-filters">
        <label>
          Comparison from
          <input type="date" value={from} min={earliestDate} max={latestDate} onChange={(event) => onFrom(event.target.value)} />
        </label>
        <label>
          Comparison to
          <input type="date" value={to} min={earliestDate} max={latestDate} onChange={(event) => onTo(event.target.value)} />
        </label>
      </div>
      {days.length > 1 ? <TrendChart days={days} /> : <p className="empty">No matching records found.</p>}
      {days.length > 1 ? <div className="comparison-scroll">
        <table className="comparison">
          <thead>
            <tr>
              <th>Date</th>
              {metrics.map(([, label]) => (
                <th key={label}>{label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {days.map((day) => (
              <tr key={day.date}>
                <td>{day.date}</td>
                {metrics.map(([key]) => {
                  const change = key === "conversion" ? pointText(day.changes[key]) : changeText(day.changes[key])
                  const value = key === "conversion" ? day.conversion : day[key]
                  return (
                    <td key={key}>
                      <strong>{value}</strong>
                      <span className={`change ${change.direction}`}>{change.text}</span>
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div> : null}
    </section>
  )
}

function CourseList({ courses, search, onSearch, onOpenCourse }) {
  return (
    <section className="course-list" aria-label="Courses" data-count={courses.length}>
      <div className="list-tools">
        <h2>Courses {courses.length}</h2>
        <label>
          Search courses
          <input
            type="search"
            value={search}
            placeholder="Course name"
            onChange={(event) => onSearch(event.target.value)}
          />
        </label>
      </div>
      {courses.length === 0 ? <p className="empty">No matching records found.</p> : null}
      {courses.map((course) => (
        <button
          type="button"
          className="course-row"
          key={course.name}
          data-course={course.name}
          onClick={() => onOpenCourse(course)}
        >
          <span className="course-row-name">
            <strong>{course.name}</strong>
          </span>
          <Metric label="Total Calls" value={course.totalCalls} />
          <Metric label="Successful Bookings" value={course.successful} />
          <Metric label="Booking Not Completed" value={course.notCompleted} />
          <Metric label="Unclear Calls" value={course.unclear} />
          <Metric label="Conversion" value={course.conversionLabel} />
        </button>
      ))}
    </section>
  )
}

function CourseDetail({
  course,
  summary,
  reasons,
  reasonGroups,
  reasonFilter,
  reasonOptions,
  openReasons,
  openCalls,
  copiedId,
  onReasonChange,
  onToggleReason,
  onToggleCall,
  onCopy,
  onDownload,
  dailyComparison = [],
  dailyFrom = "",
  dailyTo = "",
  earliestDate = "",
  latestDate = "",
  onDailyFrom,
  onDailyTo,
}) {
  if (!course) {
    return <p className="empty">No matching records found.</p>
  }
  return (
    <>
      <section className="summary" aria-label="Course summary" data-course={course.name} data-date={course.date}>
        <div className="summary-head">
          <h2>{course.name}</h2>
          <div className="views">
            <CopyButton
              id={`course:${courseKey(course)}`}
              label="Copy course"
              copiedId={copiedId}
              onCopy={() => onCopy(`course:${courseKey(course)}`, courseText(course, reasonFilter === "all" ? "" : reasonFilter))}
            />
            <button type="button" className="copy" onClick={onDownload}>
              Download Report
            </button>
          </div>
        </div>
        <SummaryCards summary={summary} />
      </section>
      <CourseDailyComparison
        courseName={course.name}
        days={dailyComparison}
        from={dailyFrom}
        to={dailyTo}
        earliestDate={earliestDate}
        latestDate={latestDate}
        onFrom={onDailyFrom}
        onTo={onDailyTo}
      />
      <Charts summary={summary} reasonGroups={reasonGroups} courses={[course]} />
      <section className="filters detail-filters" aria-label="Failure reason filter">
        <label>
          Failure reason
          <select value={reasonFilter} onChange={(event) => onReasonChange(event.target.value)}>
            <option value="all">All reasons</option>
            {reasonOptions.map((reason) => (
              <option key={reason} value={reason}>
                {reason}
              </option>
            ))}
          </select>
        </label>
      </section>
      <section className="reasons" aria-label="Failure reasons">
        <h3>Failure Reasons</h3>
        {reasons.length === 0 ? <p className="empty">No matching records found.</p> : null}
        {reasons.map((reason) => {
          const key = `${courseKey(course)}|${reason.reason}`
          const open = Boolean(openReasons[key])
          return (
            <div className="reason" key={key} data-reason={reason.reason} data-count={reason.count}>
              <div className="reason-head">
                <button type="button" onClick={() => onToggleReason(key)}>
                  {reason.reason} — {reason.count}
                </button>
                <button type="button" className="view" onClick={() => onToggleReason(key)}>
                  {open ? "Hide details" : "View details"}
                </button>
                <CopyButton
                  id={`reason:${key}`}
                  label="Copy reason"
                  copiedId={copiedId}
                  onCopy={() => onCopy(`reason:${key}`, reasonText(course, reason))}
                />
              </div>
              {open ? (
                <CallList
                  calls={reason.calls}
                  course={course}
                  reasonName={reason.reason}
                  openCalls={openCalls}
                  copiedId={copiedId}
                  onToggleCall={onToggleCall}
                  onCopy={onCopy}
                />
              ) : null}
            </div>
          )
        })}
      </section>
    </>
  )
}

function CallList({ calls, course, reasonName, openCalls, copiedId, onToggleCall, onCopy }) {
  return (
    <ul className="calls">
      {(calls || []).map((call, index) => {
        const key = `${course.date}|${course.name}|${reasonName}|${index}|${call.callId || ""}`
        const open = Boolean(openCalls[key])
        return (
          <li key={key} data-call-id={call.callId || ""}>
            <div className="call-head">
              <p>
                <span>Call ID</span> {call.callId || "Not stated"}
              </p>
              <button type="button" className="view" onClick={() => onToggleCall(key)}>
                {open ? "Hide details" : "View details"}
              </button>
              <CopyButton
                id={`call:${key}`}
                label="Copy call"
                copiedId={copiedId}
                onCopy={() => onCopy(`call:${key}`, callText(course, { reason: reasonName }, call))}
              />
            </div>
            {open ? (
              <>
                <p>
                  <span>What happened</span> {call.whatHappened || "Not stated"}
                </p>
                <p>
                  <span>Why not completed</span> {call.whyNotCompleted || "Not stated"}
                </p>
              </>
            ) : null}
          </li>
        )
      })}
    </ul>
  )
}

function SummaryCards({ summary }) {
  return (
    <div className="cards">
      <SummaryCard label="Total Calls" value={summary.totalCalls} />
      <SummaryCard label="Successful Bookings" value={summary.successful} />
      <SummaryCard label="Booking Not Completed" value={summary.notCompleted} />
      <SummaryCard label="Unclear Calls" value={summary.unclear} />
      <SummaryCard label="Conversion" value={summary.conversion} />
    </div>
  )
}

function Metric({ label, value }) {
  return (
    <span>
      {label}
      <strong>{value}</strong>
    </span>
  )
}

function SummaryCard({ label, value }) {
  return (
    <article className="card" data-summary={label}>
      <p>{label}</p>
      <strong>{value}</strong>
    </article>
  )
}

function CopyButton({ id, label, copiedId, onCopy, disabled = false }) {
  return (
    <button type="button" className="copy" onClick={onCopy} disabled={disabled}>
      {copiedId === id ? "Copied" : label}
    </button>
  )
}
