export function TrendChart({ days }) {
  const width = 640
  const height = 220
  const pad = { top: 16, right: 12, bottom: 36, left: 40 }
  const innerWidth = width - pad.left - pad.right
  const innerHeight = height - pad.top - pad.bottom
  const max = Math.max(...days.map((day) => day.totalCalls), 1)
  const xAt = (index) => pad.left + (days.length === 1 ? innerWidth / 2 : (index / (days.length - 1)) * innerWidth)
  const yAt = (value) => pad.top + innerHeight - (value / max) * innerHeight
  const pathFor = (key) =>
    days
      .map((day, index) => `${index === 0 ? "M" : "L"} ${xAt(index).toFixed(1)} ${yAt(day[key]).toFixed(1)}`)
      .join(" ")

  return (
    <div className="trend">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Daily trend for calls and successful bookings">
        <line x1={pad.left} y1={pad.top} x2={pad.left} y2={pad.top + innerHeight} stroke="#313a4a" />
        <line x1={pad.left} y1={pad.top + innerHeight} x2={pad.left + innerWidth} y2={pad.top + innerHeight} stroke="#313a4a" />
        <path d={pathFor("totalCalls")} fill="none" stroke="#9aa3b2" strokeWidth="2.5" />
        <path d={pathFor("successful")} fill="none" stroke="#3dd68c" strokeWidth="2.5" />
        {days.map((day, index) => (
          <g key={day.date}>
            <circle cx={xAt(index)} cy={yAt(day.totalCalls)} r="3.5" fill="#9aa3b2" />
            <circle cx={xAt(index)} cy={yAt(day.successful)} r="3.5" fill="#3dd68c" />
            <text x={xAt(index)} y={height - 12} textAnchor="middle" fontSize="11" fill="#9aa3b2">
              {day.date.slice(5)}
            </text>
          </g>
        ))}
      </svg>
      <div className="trend-legend">
        <span><i className="swatch" style={{ background: "#9aa3b2" }} /> Total Calls</span>
        <span><i className="swatch" style={{ background: "#3dd68c" }} /> Successful Bookings</span>
      </div>
    </div>
  )
}

export function Charts({ summary, reasonGroups, courses, showConversion = false }) {
  if (!courses.length) {
    return (
      <section className="charts" aria-label="Charts">
        <p className="empty">No matching records found.</p>
      </section>
    )
  }

  return (
    <section className="charts" aria-label="Charts">
      <OutcomePie summary={summary} />
      <ReasonBars reasonGroups={reasonGroups} />
      {showConversion ? <ConversionBars courses={courses} /> : null}
    </section>
  )
}

function OutcomePie({ summary }) {
  const parts = [
    { label: "Successful Bookings", value: summary.successful, color: "#3dd68c" },
    { label: "Booking Not Completed", value: summary.notCompleted, color: "#f07178" },
    { label: "Unclear Calls", value: summary.unclear, color: "#e6b325" },
  ]
  const total = parts.reduce((sum, part) => sum + part.value, 0)
  let cursor = 0
  const gradient =
    total > 0
      ? parts
          .map((part) => {
            const start = cursor
            cursor += (part.value / total) * 100
            return `${part.color} ${start}% ${cursor}%`
          })
          .join(", ")
      : "#243044 0% 100%"

  return (
    <article className="chart" data-chart="outcomes">
      <h3>Call outcomes</h3>
      <p className="chart-note">Report totals for the courses in this filter.</p>
      <div className="pie-row">
        <div className="pie" style={{ background: `conic-gradient(${gradient})` }} />
        <ul className="legend">
          {parts.map((part) => (
            <li key={part.label} data-outcome={part.label} data-count={part.value}>
              <span className="swatch" style={{ background: part.color }} />
              <span>{part.label}</span>
              <strong>{part.value}</strong>
            </li>
          ))}
        </ul>
      </div>
    </article>
  )
}

function ReasonBars({ reasonGroups }) {
  const max = Math.max(...reasonGroups.map((group) => group.count), 0)
  return (
    <article className="chart" data-chart="reasons">
      <h3>Failure reasons</h3>
      <p className="chart-note">Failure-reason counts for this filter.</p>
      {reasonGroups.length === 0 ? <p className="empty">No matching records found.</p> : null}
      <ul className="bars">
        {reasonGroups.map((group) => (
          <li key={group.reason} data-reason={group.reason} data-count={group.count}>
            <span className="bar-label">{group.reason}</span>
            <span className="bar-track">
              <span className="bar-fill" style={{ width: max ? `${(group.count / max) * 100}%` : "0%" }} />
            </span>
            <strong>{group.count}</strong>
          </li>
        ))}
      </ul>
    </article>
  )
}

function ConversionBars({ courses }) {
  return (
    <article className="chart" data-chart="conversion">
      <h3>Course conversion</h3>
      <ul className="bars conversion-bars">
        {courses.map((course) => {
          const width = Math.min(Math.max(course.conversionNumber, 0), 100)
          return (
            <li key={`${course.date}|${course.name}`} data-course={course.name} data-conversion={course.conversionLabel}>
              <span className="bar-label">
                {course.name}
                {course.showDate ? <span className="date-tag">{course.date}</span> : null}
              </span>
              <span className="bar-track">
                <span className="bar-fill conversion-fill" style={{ width: `${width}%` }} />
              </span>
              <strong>{course.conversionLabel}</strong>
            </li>
          )
        })}
      </ul>
    </article>
  )
}
