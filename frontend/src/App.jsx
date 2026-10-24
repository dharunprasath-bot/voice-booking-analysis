import { useEffect, useMemo, useRef, useState } from "react"
import { groupAbandonedCalls } from "./abandonedStage.js"
import { Charts, TrendChart } from "./Charts.jsx"
import { downloadCourseReport } from "./courseReportPdf.js"
import { callText, courseText, filteredText, reasonText, summaryText } from "./copyText.js"
import {
  aggregateReasons,
  buildFilteredView,
  compareCourseRows,
  compareDays,
  conversionLabel,
  coursesForDate,
  coursesForDates,
  datesInRange,
  reasonNames,
  summarize,
} from "./filterReport.js"
import { buildFlowReports, callsQuery, phoneRows, REASON_NOT_AVAILABLE, UNCLASSIFIED } from "./flowData.js"

function courseKey(course) {
  return `${course.date}|${course.key || `${course.kind || ""}:${course.courseId ?? ""}`}`
}

function sameCourse(course, selected) {
  return Boolean(selected) && course.key === selected.key
}

function listedCourseFromGroup(group) {
  const totals = summarize([])
  return {
    key: group.key,
    name: group.name,
    kind: group.kind,
    courseId: group.id ?? null,
    ...totals,
    conversionLabel: totals.conversion,
  }
}

function groupByCourseId(courses) {
  const groups = new Map()
  for (const course of courses || []) {
    const rows = groups.get(course.key)
    if (rows) rows.push(course)
    else groups.set(course.key, [course])
  }
  return [...groups.values()]
    .map((rows) => {
      const totals = summarize(rows)
      return {
        key: rows[0].key,
        name: rows[0].name,
        kind: rows[0].kind,
        courseId: rows[0].courseId ?? null,
        ...totals,
        conversionLabel: totals.conversion,
      }
    })
    .sort((left, right) => left.name.localeCompare(right.name) || (left.courseId ?? 0) - (right.courseId ?? 0))
}

function scopeRange(dates) {
  if (!dates.length) return {}
  const sorted = [...dates].sort()
  return { from: sorted[0], to: sorted[sorted.length - 1] }
}

const REPORT_FETCH_TIMEOUT_MS = 20000
const FLOW_FETCH_TIMEOUT_MS = 300000
const CALL_PAGE_SIZE = 50
const COURSE_CALL_LIMIT = 20000
const DATE_INPUT_DELAY_MS = 400
const LOADING_STATUS = "Loading course flow…"
const LOAD_ERROR = "Unable to load report. Please try again."
const TIMEOUT_ERROR = "The report request timed out. Please try again."

function usableDate(value, min, max) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return false
  return (!min || value >= min) && (!max || value <= max)
}

function DateInput({ value, min, max, onChange }) {
  const [draft, setDraft] = useState(value)
  const timer = useRef(0)
  const inputRef = useRef(null)
  const latest = useRef(value)
  latest.current = value

  useEffect(() => {
    if (document.activeElement !== inputRef.current) setDraft(value)
  }, [value])

  useEffect(() => () => window.clearTimeout(timer.current), [])

  function commit(next) {
    window.clearTimeout(timer.current)
    if (next !== latest.current && usableDate(next, min, max)) onChange(next)
  }

  return (
    <input
      ref={inputRef}
      type="date"
      value={draft}
      min={min}
      max={max}
      onChange={(event) => {
        const next = event.target.value
        setDraft(next)
        window.clearTimeout(timer.current)
        timer.current = window.setTimeout(() => commit(next), DATE_INPUT_DELAY_MS)
      }}
      onBlur={(event) => {
        commit(event.target.value)
        if (!usableDate(event.target.value, min, max)) setDraft(latest.current)
      }}
    />
  )
}

async function fetchReportJson(url, timeout = REPORT_FETCH_TIMEOUT_MS) {
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), timeout)
  try {
    const response = await fetch(url, { signal: controller.signal })
    const body = await response.json()
    return { response, body }
  } catch (error) {
    throw new Error(error && error.name === "AbortError" ? TIMEOUT_ERROR : LOAD_ERROR)
  } finally {
    window.clearTimeout(timer)
  }
}

function DateMenu({ value, dates, disabled, onChange }) {
  const [open, setOpen] = useState(false)
  const [menuBox, setMenuBox] = useState(null)
  const rootRef = useRef(null)
  const options = [
    { value: "all", label: "All dates" },
    { value: "range", label: "Custom range" },
    ...dates.map((date) => ({ value: date, label: date })),
  ]
  const current = options.find((option) => option.value === value)
  const label = current ? current.label : "Loading dates…"

  function place() {
    const button = rootRef.current?.querySelector(".date-menu-button")
    if (!button) return
    const rect = button.getBoundingClientRect()
    const spaceBelow = window.innerHeight - rect.bottom
    const spaceAbove = rect.top
    const dropUp = spaceBelow < 280 && spaceAbove > spaceBelow
    setMenuBox({
      position: "fixed",
      left: `${Math.round(rect.left)}px`,
      width: `${Math.round(rect.width)}px`,
      maxHeight: "240px",
      zIndex: 50,
      ...(dropUp
        ? { bottom: `${Math.round(window.innerHeight - rect.top + 4)}px` }
        : { top: `${Math.round(rect.bottom + 4)}px` }),
    })
  }

  useEffect(() => {
    if (!open) return undefined
    function onPointer(event) {
      if (!rootRef.current?.contains(event.target)) setOpen(false)
    }
    function onKey(event) {
      if (event.key === "Escape") setOpen(false)
    }
    document.addEventListener("mousedown", onPointer)
    document.addEventListener("keydown", onKey)
    window.addEventListener("resize", place)
    window.addEventListener("scroll", place, true)
    return () => {
      document.removeEventListener("mousedown", onPointer)
      document.removeEventListener("keydown", onKey)
      window.removeEventListener("resize", place)
      window.removeEventListener("scroll", place, true)
    }
  }, [open])

  function toggle() {
    if (disabled) return
    if (!open) place()
    setOpen((currentOpen) => !currentOpen)
  }

  return (
    <div className="date-menu" ref={rootRef}>
      <button
        type="button"
        className="date-menu-button"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={toggle}
      >
        {label}
      </button>
      {open ? (
        <ul className="date-menu-list" role="listbox" aria-label="Date" style={menuBox || undefined}>
          {options.map((option) => (
            <li key={option.value}>
              <button
                type="button"
                role="option"
                aria-selected={option.value === value}
                className={option.value === value ? "selected" : ""}
                onClick={() => {
                  onChange(option.value)
                  setOpen(false)
                }}
              >
                {option.label}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

export default function App() {
  const [flow, setFlow] = useState(null)
  const [status, setStatus] = useState(LOADING_STATUS)
  const [copyMessage, setCopyMessage] = useState("")
  const [courseCalls, setCourseCalls] = useState({ scope: "", calls: [], loading: false })
  const [callGroup, setCallGroup] = useState("all")
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
  const [detailReturn, setDetailReturn] = useState("courses")
  const [selectedCourse, setSelectedCourse] = useState(null)
  const [openReasons, setOpenReasons] = useState({})
  const [openCalls, setOpenCalls] = useState({})
  const [copiedId, setCopiedId] = useState("")
  const [navCollapsed, setNavCollapsed] = useState(false)
  const [navOpen, setNavOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    async function loadFlow() {
      try {
        const { response, body } = await fetchReportJson("/api/flow", FLOW_FETCH_TIMEOUT_MS)
        if (!response.ok || !Array.isArray(body.days) || !Array.isArray(body.groups)) throw new Error(body.error || LOAD_ERROR)
        if (cancelled) return
        const newest = [...body.days].sort().reverse()[0] || ""
        setFlow(body)
        setDateFilter((current) => current || newest)
        setCompareFrom((current) => current || newest)
        setCompareTo((current) => current || newest)
        setDailyFrom((current) => current || newest)
        setDailyTo((current) => current || newest)
        setStatus(body.days.length ? "" : "No calls found.")
      } catch (error) {
        if (!cancelled) setStatus(error.message === TIMEOUT_ERROR ? TIMEOUT_ERROR : LOAD_ERROR)
      }
    }
    loadFlow()
    return () => {
      cancelled = true
    }
  }, [])

  const dates = useMemo(() => (flow ? [...flow.days].sort().reverse() : []), [flow])
  const flowReports = useMemo(() => buildFlowReports(flow), [flow])
  const groupsByKey = useMemo(() => new Map((flow?.groups || []).map((group) => [group.key, group])), [flow])

  const activeDates = useMemo(() => {
    if (!dateFilter) return []
    if (dateFilter === "all") return [...dates].sort()
    if (dateFilter === "range") return datesInRange(dates, rangeFrom, rangeTo)
    return dates.includes(dateFilter) ? [dateFilter] : []
  }, [dates, dateFilter, rangeFrom, rangeTo])

  const dateCourses = useMemo(() => coursesForDates(flowReports, activeDates), [flowReports, activeDates])

  const comparisonDates = useMemo(
    () => datesInRange(dates, compareFrom, compareTo),
    [dates, compareFrom, compareTo],
  )

  const comparisonDays = useMemo(() => compareDays(flowReports, comparisonDates), [flowReports, comparisonDates])

  const rangeLabel = useMemo(() => dateScopeLabel(dateFilter, rangeFrom, rangeTo), [dateFilter, rangeFrom, rangeTo])

  const overview = useMemo(() => {
    const view = buildFilteredView(dateCourses, { courseFilter: "all", reasonFilter: "all", search: "" })
    return {
      ...view,
      courses: view.courses.map(withConversion),
    }
  }, [dateCourses])

  const allCourses = useMemo(() => coursesForDate(flowReports, "all"), [flowReports])

  const listedCourses = useMemo(() => {
    const totaled = groupByCourseId(dateCourses.filter((course) => course.kind === "SCO" || course.kind === "MCO"))
    const byKey = new Map(totaled.map((course) => [course.key, course]))
    const query = courseSearch.trim().toLowerCase()
    const merged = (flow?.groups || [])
      .filter((group) => group.kind === "SCO" || group.kind === "MCO")
      .map((group) => byKey.get(group.key) || listedCourseFromGroup(group))
      .filter((course) => !query || course.name.toLowerCase().includes(query))
      .sort((left, right) => left.name.localeCompare(right.name) || (left.courseId ?? 0) - (right.courseId ?? 0))
    return {
      sco: merged.filter((course) => course.kind === "SCO"),
      mco: merged.filter((course) => course.kind === "MCO"),
      v1: [],
      unclassified: summarize(dateCourses.filter((course) => course.key === UNCLASSIFIED)),
    }
  }, [dateCourses, courseSearch, flow])

  const detailRows = useMemo(() => {
    if (!selectedCourse || !dateFilter) return []
    const allowed = new Set(activeDates)
    return allCourses.filter((course) => sameCourse(course, selectedCourse) && allowed.has(course.date))
  }, [allCourses, selectedCourse, activeDates])

  const dailyDates = useMemo(
    () => datesInRange(dates, dailyFrom, dailyTo),
    [dates, dailyFrom, dailyTo],
  )

  const courseComparisonDays = useMemo(() => {
    if (!selectedCourse) return []
    const allowed = new Set(dailyDates)
    const rows = allCourses.filter((course) => sameCourse(course, selectedCourse) && allowed.has(course.date))
    return compareCourseRows(rows)
  }, [allCourses, selectedCourse, dailyDates])

  const courseScope = useMemo(() => {
    if (page !== "detail" || !selectedCourse || !activeDates.length) return ""
    const range = dateFilter === "all" ? {} : scopeRange(activeDates)
    return callsQuery({ group: selectedCourse.key, outcome: "notbooked", ...range, size: COURSE_CALL_LIMIT })
  }, [page, selectedCourse, activeDates, dateFilter])

  useEffect(() => {
    if (!courseScope) return undefined
    let cancelled = false
    setCourseCalls({ scope: courseScope, calls: [], loading: true })
    fetchReportJson(courseScope, FLOW_FETCH_TIMEOUT_MS).then(
      ({ response, body }) => {
        if (cancelled) return
        if (!response.ok || !Array.isArray(body.calls)) throw new Error(body.error || LOAD_ERROR)
        setCourseCalls({ scope: courseScope, calls: body.calls, loading: false })
      },
    ).catch((error) => {
      if (cancelled) return
      setCourseCalls({ scope: courseScope, calls: [], loading: false })
      setStatus(error.message === TIMEOUT_ERROR ? TIMEOUT_ERROR : LOAD_ERROR)
    })
    return () => {
      cancelled = true
    }
  }, [courseScope])

  const detail = useMemo(() => {
    if (!selectedCourse) {
      return { course: null, summary: summarize([]), reasonGroups: [], reasons: [], phones: [] }
    }
    const summary = summarize(detailRows)
    const callsByReason = new Map()
    if (courseCalls.scope === courseScope) {
      for (const call of courseCalls.calls) {
        const rows = callsByReason.get(call.reason)
        if (rows) rows.push(call)
        else callsByReason.set(call.reason, [call])
      }
    }
    const reasonGroups = aggregateReasons(detailRows, reasonFilter)
    const reasons = reasonGroups.map((group) => ({
      reason: group.reason,
      count: group.count,
      calls: callsByReason.get(group.reason) || [],
    }))
    const group = groupsByKey.get(selectedCourse.key)
    const configured = (group?.phones || []).map((index) => flow.phones[index])
    const course = {
      key: selectedCourse.key,
      name: selectedCourse.name,
      kind: selectedCourse.kind || "",
      courseId: selectedCourse.courseId,
      date: rangeLabel,
      ...summary,
      conversionLabel: summary.conversion,
      reasons,
      configIds: group?.configIds || [],
      configNames: group?.configNames || [],
      nameSource: group?.nameSource || "",
    }
    return { course, summary, reasonGroups, reasons, phones: phoneRows(detailRows, configured) }
  }, [detailRows, reasonFilter, selectedCourse, rangeLabel, courseCalls, courseScope, groupsByKey, flow])

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

  const comparisonLoaded = Boolean(flow)
  const dailyLoaded = Boolean(flow)

  const listShown = dates.length > 0
  const ready = listShown && Boolean(flow)
  const apiRange = useMemo(() => (dateFilter === "all" ? {} : scopeRange(activeDates)), [dateFilter, activeDates])

  useEffect(() => {
    if (!dates.length) return
    setCompareFrom((current) => current || dates[0])
    setCompareTo((current) => current || dates[0])
    setDailyFrom((current) => current || dates[0])
    setDailyTo((current) => current || dates[0])
  }, [dates])

  useEffect(() => {
    setCopiedId("")
    setCopyMessage("")
  }, [dateFilter, rangeFrom, rangeTo, reasonFilter, courseSearch, page, selectedCourse])

  function changeDate(value) {
    const start = dates.includes(dateFilter) ? dateFilter : dates[0] || ""
    setDateFilter(value)
    if (value === "range") {
      setRangeFrom((current) => current || start)
      setRangeTo((current) => current || start)
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
    setSelectedCourse({ key: course.key, name: course.name, kind: course.kind || "", courseId: course.courseId ?? null })
    setDetailReturn(page === "v1" ? "v1" : "courses")
    setPage("detail")
    setOpenReasons({})
    setOpenCalls({})
  }

  function openCourseCalls(nextPage, group) {
    setCallGroup(group)
    setPage(nextPage)
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

  function openPage(nextPage) {
    setPage(nextPage)
    setNavOpen(false)
  }

  return (
    <div className={`app-shell${navCollapsed ? " nav-collapsed" : ""}${navOpen ? " nav-open" : ""}`}>
      <aside className="sidebar" aria-label="Dashboard">
        <div className="sidebar-brand">
          <span className="brand-mark" aria-hidden="true">CR</span>
          <span className="brand-name">CourseRev</span>
        </div>
        <nav>
          <button type="button" className={page === "overview" ? "active" : ""} onClick={() => openPage("overview")}>
            <span className="nav-icon" aria-hidden="true">▦</span>
            <span>Dashboard</span>
          </button>
          <button type="button" className={page === "courses" || (page === "detail" && detailReturn !== "v1") ? "active" : ""} onClick={() => openPage("courses")}>
            <span className="nav-icon" aria-hidden="true">☰</span>
            <span>Course list</span>
          </button>
          <button type="button" className={page === "v1" || (page === "detail" && detailReturn === "v1") ? "active" : ""} onClick={() => openPage("v1")}>
            <span className="nav-icon" aria-hidden="true">☰</span>
            <span>V1 Course List</span>
          </button>
          <button type="button" className={page === "comparison" ? "active" : ""} onClick={() => openPage("comparison")}>
            <span className="nav-icon" aria-hidden="true">↗</span>
            <span>Daily Comparison</span>
          </button>
          <button type="button" className={page === "unbooked" ? "active" : ""} onClick={() => openCourseCalls("unbooked", "all")}>
            <span className="nav-icon" aria-hidden="true">?</span>
            <span>Unbooked Analysis</span>
          </button>
          <button type="button" className={page === "booked" ? "active" : ""} onClick={() => openCourseCalls("booked", "all")}>
            <span className="nav-icon" aria-hidden="true">✓</span>
            <span>Booked Calls</span>
          </button>
        </nav>
        <button type="button" className="nav-collapse" onClick={() => setNavCollapsed((current) => !current)}>
          <span className="nav-icon" aria-hidden="true">{navCollapsed ? "›" : "‹"}</span>
          <span>{navCollapsed ? "Expand" : "Collapse"}</span>
        </button>
      </aside>
      {navOpen ? (
        <button type="button" className="nav-backdrop" aria-label="Close menu" onClick={() => setNavOpen(false)} />
      ) : null}
    <main data-page={page}>
      <header>
        <button type="button" className="nav-toggle" aria-label="Open menu" onClick={() => setNavOpen(true)}>
          ☰
        </button>
        <div>
          <h1>Course booking reports</h1>
          <p>
            {page === "overview" ? "Overall dashboard" : page === "courses" ? "Course list" : page === "v1" ? "V1 Course List" : page === "comparison" ? "Daily Comparison" : page === "unbooked" ? "Unbooked Analysis" : page === "booked" ? "Booked Calls" : "Course detail"}
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

      {page === "comparison" ? null : (
      <section className={`filters overview-filters${dateFilter === "range" ? " range-filters" : ""}`} aria-label="Report filters">
        <label>
          Date
          <DateMenu
            value={dateFilter || ""}
            dates={dates}
            disabled={!dates.length}
            onChange={changeDate}
          />
        </label>
        {dateFilter === "range" ? (
          <>
            <label>
              From date
              <DateInput
                value={rangeFrom}
                min={dates[dates.length - 1] || ""}
                max={dates[0] || ""}
                onChange={setRangeFrom}
              />
            </label>
            <label>
              To date
              <DateInput
                value={rangeTo}
                min={dates[dates.length - 1] || ""}
                max={dates[0] || ""}
                onChange={setRangeTo}
              />
            </label>
          </>
        ) : null}
      </section>
      )}

      {page === "courses" || page === "v1" || page === "detail" ? (
        <div className="sticky-bar">
          <button
            type="button"
            className="back"
            onClick={() => setPage(page === "detail" ? detailReturn : "overview")}
          >
            {page === "detail" ? (detailReturn === "v1" ? "Back to V1 Course List" : "Back to Course List") : "Back to Dashboard"}
          </button>
          <p className="sticky-date">{rangeLabel}</p>
          {page === "detail" ? (
            <button type="button" className="clear" onClick={clearReasonFilter}>
              Clear filter
            </button>
          ) : null}
        </div>
      ) : null}

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
          onOpenCourses={() => setPage("courses")}
        />
      ) : null}

      {listShown && page === "comparison" ? (
        <DateComparison
          title="Daily Comparison"
          days={comparisonDays}
          loading={!comparisonLoaded}
          from={compareFrom}
          to={compareTo}
          earliestDate={dates[dates.length - 1] || ""}
          latestDate={dates[0] || ""}
          onFrom={setCompareFrom}
          onTo={setCompareTo}
        />
      ) : null}

      {ready && page === "courses" ? (
        <CourseList
          scoCourses={listedCourses.sco}
          mcoCourses={listedCourses.mco}
          unclassified={listedCourses.unclassified}
          search={courseSearch}
          onSearch={setCourseSearch}
          onOpenCourse={openCourse}
        />
      ) : null}

      {ready && page === "v1" ? (
        <V1CourseList
          courses={listedCourses.v1}
          search={courseSearch}
          onSearch={setCourseSearch}
          onOpenCourse={openCourse}
        />
      ) : null}

      {ready && page === "detail" ? (
        <CourseDetail
          course={detail.course}
          summary={detail.summary}
          phones={detail.phones}
          callsLoading={courseCalls.loading}
          onOpenBooked={() => openCourseCalls("booked", detail.course?.key || "all")}
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
          dailyLoading={!dailyLoaded}
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

      {ready && page === "unbooked" ? (
        <UnbookedAnalysis
          courses={dateCourses}
          groups={flow.groups}
          range={apiRange}
          rangeLabel={rangeLabel}
          group={callGroup}
          onGroup={setCallGroup}
        />
      ) : null}

      {ready && page === "booked" ? (
        <BookedCalls
          courses={dateCourses}
          groups={flow.groups}
          range={apiRange}
          rangeLabel={rangeLabel}
          group={callGroup}
          onGroup={setCallGroup}
        />
      ) : null}
    </main>
    </div>
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
  loading = false,
}) {
  const metrics = [
    ["totalCalls", "Total Calls"],
    ["successful", "Successful Bookings"],
    ["notCompleted", "Not Booked (Saved Reason)"],
    ["unclear", "Reason Not Available"],
    ["conversion", "Conversion %"],
  ]
  return (
    <section className="chart" aria-label={title} data-course={courseName || undefined}>
      <h3>{title}</h3>
      <p className="chart-note">{note}</p>
      {controls ? <div className="filters range-filters comparison-filters">
        <label>
          From date
          <DateInput value={from} min={earliestDate} max={latestDate} onChange={onFrom} />
        </label>
        <label>
          To date
          <DateInput value={to} min={earliestDate} max={latestDate} onChange={onTo} />
        </label>
      </div> : null}
      {loading ? null : days.length ? <TrendChart days={days} /> : <p className="empty">No matching records found.</p>}
      {!loading && days.length ? <div className="comparison-scroll">
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

function CourseDailyComparison({ courseName, days, loading, from, to, earliestDate, latestDate, onFrom, onTo }) {
  const metrics = [
    ["totalCalls", "Total Calls"],
    ["successful", "Successful Bookings"],
    ["notCompleted", "Not Booked (Saved Reason)"],
    ["unclear", "Reason Not Available"],
    ["conversion", "Conversion %"],
  ]
  return (
    <section className="chart" aria-label="Daily Comparison" data-course={courseName}>
      <h3>Daily Comparison</h3>
      <p className="chart-note">{courseName} only. This range is separate from the date filter.</p>
      <div className="filters range-filters comparison-filters">
        <label>
          Comparison from
          <DateInput value={from} min={earliestDate} max={latestDate} onChange={onFrom} />
        </label>
        <label>
          Comparison to
          <DateInput value={to} min={earliestDate} max={latestDate} onChange={onTo} />
        </label>
      </div>
      {loading ? null : days.length > 1 ? <TrendChart days={days} /> : <p className="empty">No matching records found.</p>}
      {!loading && days.length > 1 ? <div className="comparison-scroll">
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

function CourseRows({ courses, onOpenCourse }) {
  if (courses.length === 0) return <p className="empty">No matching records found.</p>
  return courses.map((course) => (
    <button
      type="button"
      className="course-row"
      key={course.key}
      data-course={course.name}
      data-kind={course.kind || undefined}
      data-course-id={course.courseId ?? undefined}
      onClick={() => onOpenCourse(course)}
    >
      <span className="course-row-name">
        <strong>{course.name}</strong>
        <span className="date-tag">{course.kind === "MCO" ? "Organization" : "Golf Course"} ID {course.courseId}</span>
      </span>
      <Metric label="Total Calls" value={course.totalCalls} />
      <Metric label="Successful Bookings" value={course.successful} />
      <Metric label="Not Booked (Saved Reason)" value={course.notCompleted} />
      <Metric label="Reason Not Available" value={course.unclear} />
      <Metric label="Conversion" value={course.conversionLabel} />
    </button>
  ))
}

function V1CourseList({ courses, search, onSearch, onOpenCourse }) {
  return (
    <section className="course-list" aria-label="V1 Course List" data-count={courses.length}>
      <div className="list-tools">
        <h2>V1 Course List {courses.length}</h2>
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
      <div className="course-group" aria-label="V1 Course List" data-count={courses.length}>
        <CourseRows courses={courses} onOpenCourse={onOpenCourse} />
      </div>
    </section>
  )
}

function CourseList({ scoCourses, mcoCourses, unclassified, search, onSearch, onOpenCourse }) {
  const total = scoCourses.length + mcoCourses.length
  return (
    <section className="course-list" aria-label="Courses" data-count={total}>
      <div className="list-tools">
        <h2>Courses {total}</h2>
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
      <div className="course-group" aria-label="SCO Course List" data-count={scoCourses.length}>
        <h3>SCO Course List {scoCourses.length}</h3>
        <CourseRows courses={scoCourses} onOpenCourse={onOpenCourse} />
      </div>
      <div className="course-group" aria-label="MCO list" data-count={mcoCourses.length}>
        <h3>MCO list {mcoCourses.length}</h3>
        <CourseRows courses={mcoCourses} onOpenCourse={onOpenCourse} />
      </div>
      {unclassified?.totalCalls ? (
        <p className="chart-note" data-unclassified={unclassified.totalCalls}>
          Unclassified calls: {unclassified.totalCalls}. Successful bookings {unclassified.successful}.
          These calls have a blank phone, a phone that is not in voice_numbers, or a phone that conflicts with the conversation's course ID. They are not placed on a course.
        </p>
      ) : null}
    </section>
  )
}

function CourseDetail({
  course,
  summary,
  phones = [],
  callsLoading = false,
  onOpenBooked,
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
  dailyLoading = false,
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
      <section className="summary" aria-label="Course summary" data-course={course.name} data-kind={course.kind || undefined} data-date={course.date}>
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
            <button type="button" className="view" onClick={onOpenBooked}>
              View booked calls
            </button>
          </div>
        </div>
        <p className="chart-note">
          {course.kind === "MCO" ? "Organization" : "Golf Course"} ID {course.courseId}
          {course.configIds.length ? ` · Configuration ID ${course.configIds.join(", ")}` : " · No voice configuration"}
          {course.configNames.length && !course.configNames.includes(course.name) ? ` · Configured as ${course.configNames.join(", ")}` : ""}
        </p>
        <SummaryCards summary={summary} />
      </section>
      <PhoneTable phones={phones} />
      <CourseDailyComparison
        courseName={course.name}
        days={dailyComparison}
        loading={dailyLoading}
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
        <p className="chart-note">
          Unbooked calls with the failure reason saved for that Call ID. Calls with no saved reason are listed under {REASON_NOT_AVAILABLE}.
          {callsLoading ? " Loading calls…" : ""}
        </p>
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
              {open && reason.reason === "Customer Abandoned" ? (
                <AbandonedStages
                  calls={reason.calls}
                  course={course}
                  reasonName={reason.reason}
                  openReasons={openReasons}
                  openCalls={openCalls}
                  copiedId={copiedId}
                  onToggleReason={onToggleReason}
                  onToggleCall={onToggleCall}
                  onCopy={onCopy}
                />
              ) : null}
              {open && reason.reason !== "Customer Abandoned" ? (
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

function AbandonedStages({
  calls,
  course,
  reasonName,
  openReasons,
  openCalls,
  copiedId,
  onToggleReason,
  onToggleCall,
  onCopy,
}) {
  const stages = groupAbandonedCalls(calls)
  return (
    <div className="reasons">
      {stages.map((stage) => {
        const key = `${courseKey(course)}|${reasonName}|${stage.stage}`
        const open = Boolean(openReasons[key])
        return (
          <div className="reason" key={key} data-stage={stage.stage} data-count={stage.calls.length}>
            <div className="reason-head">
              <button type="button" onClick={() => onToggleReason(key)}>
                {stage.stage} — {stage.calls.length}
              </button>
              <button type="button" className="view" onClick={() => onToggleReason(key)}>
                {open ? "Hide details" : "View details"}
              </button>
            </div>
            {open ? (
              <CallList
                calls={stage.calls}
                course={course}
                reasonName={`${reasonName}|${stage.stage}`}
                openCalls={openCalls}
                copiedId={copiedId}
                onToggleCall={onToggleCall}
                onCopy={onCopy}
              />
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

function CallList({ calls, course, reasonName, openCalls, copiedId, onToggleCall, onCopy }) {
  return (
    <ul className="calls">
      {(calls || []).map((call, index) => {
        const key = `${course.date}|${course.key || course.name}|${reasonName}|${index}|${call.callId || ""}`
        const open = Boolean(openCalls[key])
        return (
          <li key={key} data-call-id={call.callId || ""}>
            <div className="call-head">
              <p>
                <span>Call ID</span> {call.callId || "Not stated"}
                {call.date ? <span className="date-tag">{call.date}</span> : null}
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
                  <span>Why not completed</span> {call.whyNotCompleted || REASON_NOT_AVAILABLE}
                </p>
                <p>
                  <span>What happened</span> {call.whatHappened || "Not saved"}
                </p>
                {call.phone ? (
                  <p>
                    <span>Phone</span> {call.phone}
                  </p>
                ) : null}
                <Transcript callId={call.callId} available={call.hasTranscript} />
              </>
            ) : null}
          </li>
        )
      })}
    </ul>
  )
}

function Transcript({ callId, available = true }) {
  const [state, setState] = useState({ open: false, loading: false, text: "", error: "" })
  async function toggle() {
    if (state.open) {
      setState((current) => ({ ...current, open: false }))
      return
    }
    if (state.text || state.error) {
      setState((current) => ({ ...current, open: true }))
      return
    }
    setState({ open: true, loading: true, text: "", error: "" })
    try {
      const { response, body } = await fetchReportJson(`/api/transcript?callId=${encodeURIComponent(callId)}`, 60000)
      if (!response.ok) throw new Error(body.error || "Transcript not found.")
      setState({ open: true, loading: false, text: body.transcript || "", error: body.transcript ? "" : "No transcript saved for this call." })
    } catch (error) {
      setState({ open: true, loading: false, text: "", error: error.message || "Transcript could not be loaded." })
    }
  }
  if (!callId) return null
  return (
    <div className="transcript" data-call-id={callId}>
      <button type="button" className="view" onClick={toggle} disabled={!available}>
        {!available ? "No transcript" : state.open ? "Hide transcript" : "Open transcript"}
      </button>
      {state.open ? (
        state.loading ? <p className="empty">Loading transcript…</p>
          : state.error ? <p className="empty">{state.error}</p>
            : <pre className="transcript-text">{state.text}</pre>
      ) : null}
    </div>
  )
}

function PhoneTable({ phones }) {
  if (!phones.length) return null
  return (
    <section className="chart" aria-label="Phone numbers">
      <h3>Phone numbers</h3>
      <p className="chart-note">Calls for this ID by the phone they came in on. Configured phones come from voice_channel_configurations and voice_numbers.</p>
      <div className="comparison-scroll">
        <table className="comparison">
          <thead>
            <tr>
              <th>Phone</th>
              <th>Configured</th>
              <th>Total Calls</th>
              <th>With Transcript</th>
              <th>Without Transcript</th>
              <th>Successful Bookings</th>
              <th>Not Booked (Saved Reason)</th>
              <th>Reason Not Available</th>
            </tr>
          </thead>
          <tbody>
            {phones.map((row) => (
              <tr key={row.phone || "blank"} data-phone={row.phone}>
                <td>{row.phone || "(blank)"}</td>
                <td>{row.configured ? "Yes" : "No"}</td>
                <td>{row.total}</td>
                <td>{row.withTranscript}</td>
                <td>{row.total - row.withTranscript}</td>
                <td>{row.booked}</td>
                <td>{row.saved}</td>
                <td>{row.unknown}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function GroupFilter({ groups, group, onGroup }) {
  const named = groups.filter((item) => item.kind).sort((left, right) => left.name.localeCompare(right.name))
  return (
    <label>
      Course
      <select value={group} onChange={(event) => onGroup(event.target.value)}>
        <option value="all">All calls</option>
        <option value="SCO">All SCO courses</option>
        <option value="MCO">All MCO organizations</option>
        <option value={UNCLASSIFIED}>Unclassified calls</option>
        {named.map((item) => (
          <option key={item.key} value={item.key}>
            {item.name} ({item.kind} {item.id})
          </option>
        ))}
      </select>
    </label>
  )
}

function usePagedCalls(query) {
  const [state, setState] = useState({ query: "", total: 0, calls: [], loading: false, error: "" })
  useEffect(() => {
    let cancelled = false
    setState((current) => ({ ...current, query, loading: true, error: "" }))
    fetchReportJson(query, FLOW_FETCH_TIMEOUT_MS).then(
      ({ response, body }) => {
        if (cancelled) return
        if (!response.ok || !Array.isArray(body.calls)) throw new Error(body.error || LOAD_ERROR)
        setState({ query, total: body.total, calls: body.calls, loading: false, error: "" })
      },
    ).catch((error) => {
      if (!cancelled) setState({ query, total: 0, calls: [], loading: false, error: error.message || LOAD_ERROR })
    })
    return () => {
      cancelled = true
    }
  }, [query])
  return state
}

function Pager({ page, total, onPage }) {
  const pages = Math.max(1, Math.ceil(total / CALL_PAGE_SIZE))
  return (
    <div className="pager">
      <button type="button" className="view" disabled={page <= 0} onClick={() => onPage(page - 1)}>
        Previous
      </button>
      <span>
        Page {Math.min(page + 1, pages)} of {pages} · {total} {total === 1 ? "call" : "calls"}
      </span>
      <button type="button" className="view" disabled={page + 1 >= pages} onClick={() => onPage(page + 1)}>
        Next
      </button>
    </div>
  )
}

function CallTable({ calls, showReason }) {
  const [open, setOpen] = useState({})
  if (!calls.length) return <p className="empty">No matching records found.</p>
  return (
    <ul className="calls">
      {calls.map((call) => {
        const isOpen = Boolean(open[call.callId])
        return (
          <li key={call.callId} data-call-id={call.callId} data-outcome={call.outcome}>
            <div className="call-head call-head-wide">
              <p>
                <span>Call ID</span> {call.callId}
                <span className="date-tag">{call.date}</span>
              </p>
              <p>
                <span>{call.kind || "Unclassified"}</span> {call.kind ? `${call.courseName} (${call.courseId})` : "No Golf Course ID or Organization ID"}
              </p>
              <button type="button" className="view" onClick={() => setOpen((current) => ({ ...current, [call.callId]: !current[call.callId] }))}>
                {isOpen ? "Hide details" : "View details"}
              </button>
            </div>
            {showReason ? (
              <p>
                <span>Why not completed</span> {call.whyNotCompleted || REASON_NOT_AVAILABLE}
              </p>
            ) : null}
            {isOpen ? (
              <>
                {showReason ? (
                  <p>
                    <span>What happened</span> {call.whatHappened || "Not saved"}
                  </p>
                ) : null}
                <p>
                  <span>Phone</span> {call.phone || "(blank)"}
                </p>
                <Transcript callId={call.callId} available={call.hasTranscript} />
              </>
            ) : null}
          </li>
        )
      })}
    </ul>
  )
}

function UnbookedAnalysis({ courses, groups, range, rangeLabel, group, onGroup }) {
  const [reason, setReason] = useState("all")
  const [search, setSearch] = useState("")
  const [page, setPage] = useState(0)
  const scoped = useMemo(() => courses.filter((course) => {
    if (group === "all") return true
    if (group === "SCO" || group === "MCO") return course.kind === group
    return course.key === group
  }), [courses, group])
  const summary = useMemo(() => summarize(scoped), [scoped])
  const reasonGroups = useMemo(() => aggregateReasons(scoped), [scoped])
  const byKind = useMemo(() => [
    ["SCO", scoped.filter((course) => course.kind === "SCO")],
    ["MCO", scoped.filter((course) => course.kind === "MCO")],
    ["Unclassified", scoped.filter((course) => course.key === UNCLASSIFIED)],
  ].map(([label, rows]) => ({ label, ...summarize(rows) })), [scoped])
  useEffect(() => setPage(0), [group, reason, search, range.from, range.to])
  const query = callsQuery({ outcome: "notbooked", group, reason, q: search.trim(), ...range, page, size: CALL_PAGE_SIZE })
  const paged = usePagedCalls(query)
  return (
    <>
      <section className="summary" aria-label="Unbooked analysis">
        <div className="summary-head">
          <h2>Why calls did not book · {rangeLabel}</h2>
        </div>
        <SummaryCards summary={summary} />
      </section>
      <section className="chart" aria-label="Totals by classification">
        <h3>Totals by classification</h3>
        <div className="comparison-scroll">
          <table className="comparison">
            <thead>
              <tr>
                <th>Classification</th>
                <th>Total Calls</th>
                <th>With Transcript</th>
                <th>Without Transcript</th>
                <th>Successful Bookings</th>
                <th>Not Booked (Saved Reason)</th>
                <th>Reason Not Available</th>
                <th>Conversion</th>
              </tr>
            </thead>
            <tbody>
              {byKind.map((row) => (
                <tr key={row.label} data-kind={row.label}>
                  <td>{row.label}</td>
                  <td>{row.totalCalls}</td>
                  <td>{row.withTranscript}</td>
                  <td>{row.withoutTranscript}</td>
                  <td>{row.successful}</td>
                  <td>{row.notCompleted}</td>
                  <td>{row.unclear}</td>
                  <td>{row.conversion}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <Charts summary={summary} reasonGroups={reasonGroups} courses={scoped} />
      <section className="filters detail-filters" aria-label="Unbooked call filters">
        <GroupFilter groups={groups} group={group} onGroup={onGroup} />
        <label>
          Failure reason
          <select value={reason} onChange={(event) => setReason(event.target.value)}>
            <option value="all">All reasons</option>
            {reasonGroups.map((item) => (
              <option key={item.reason} value={item.reason}>
                {item.reason} ({item.count})
              </option>
            ))}
          </select>
        </label>
        <label>
          Call ID
          <input type="search" value={search} placeholder="Search Call ID" onChange={(event) => setSearch(event.target.value)} />
        </label>
      </section>
      <section className="reasons" aria-label="Unbooked calls">
        <h3>Unbooked calls</h3>
        <p className="chart-note">Each call shows the failure reason saved for its Call ID, or {REASON_NOT_AVAILABLE} when none was saved.</p>
        <Pager page={page} total={paged.total} onPage={setPage} />
        {paged.loading ? <p className="empty">Loading calls…</p> : paged.error ? <p className="empty">{paged.error}</p> : <CallTable calls={paged.calls} showReason />}
      </section>
    </>
  )
}

function BookedCalls({ courses, groups, range, rangeLabel, group, onGroup }) {
  const [search, setSearch] = useState("")
  const [page, setPage] = useState(0)
  const booked = useMemo(() => summarize(courses.filter((course) => {
    if (group === "all") return true
    if (group === "SCO" || group === "MCO") return course.kind === group
    return course.key === group
  })), [courses, group])
  useEffect(() => setPage(0), [group, search, range.from, range.to])
  const query = callsQuery({ outcome: "booked", group, q: search.trim(), ...range, page, size: CALL_PAGE_SIZE })
  const paged = usePagedCalls(query)
  return (
    <>
      <section className="summary" aria-label="Booked calls">
        <div className="summary-head">
          <h2>Booked calls · {rangeLabel}</h2>
        </div>
        <p className="chart-note">
          A call is booked when a bookings row has booking_session_id equal to its call_id, booking channel voice, and status completed, confirmed, or booked. Each call is listed once.
        </p>
        <div className="cards">
          <SummaryCard label="Successful Bookings" value={booked.successful} tone="good" />
          <SummaryCard label="Total Calls" value={booked.totalCalls} />
          <SummaryCard label="Conversion" value={booked.conversion} />
        </div>
      </section>
      <section className="filters detail-filters" aria-label="Booked call filters">
        <GroupFilter groups={groups} group={group} onGroup={onGroup} />
        <label>
          Call ID
          <input type="search" value={search} placeholder="Search Call ID" onChange={(event) => setSearch(event.target.value)} />
        </label>
      </section>
      <section className="reasons" aria-label="Booked call list">
        <Pager page={page} total={paged.total} onPage={setPage} />
        {paged.loading ? <p className="empty">Loading calls…</p> : paged.error ? <p className="empty">{paged.error}</p> : <CallTable calls={paged.calls} showReason={false} />}
      </section>
    </>
  )
}

function SummaryCards({ summary }) {
  return (
    <div className="cards">
      <SummaryCard label="Total Calls" value={summary.totalCalls} />
      <SummaryCard label="With Transcript" value={summary.withTranscript ?? 0} />
      <SummaryCard label="Without Transcript" value={summary.withoutTranscript ?? 0} />
      <SummaryCard label="Successful Bookings" value={summary.successful} tone="good" />
      <SummaryCard label="Not Booked" value={summary.notBooked ?? summary.notCompleted + summary.unclear} tone="bad" />
      <SummaryCard label="Not Booked (Saved Reason)" value={summary.notCompleted} tone="bad" />
      <SummaryCard label="Reason Not Available" value={summary.unclear} tone="warn" />
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

function SummaryCard({ label, value, tone = "" }) {
  return (
    <article className={`card${tone ? ` ${tone}` : ""}`} data-summary={label}>
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
