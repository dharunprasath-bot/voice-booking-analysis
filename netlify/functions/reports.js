const fs = require("node:fs")
const path = require("node:path")

const reportName = /^courses-(\d{4}-\d{2}-\d{2})\.txt$/

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
    body: JSON.stringify(body),
  }
}

function findReportsDir() {
  const starts = [process.cwd(), __dirname]
  const seen = new Set()
  for (const start of starts) {
    let current = start
    for (let depth = 0; depth < 8; depth += 1) {
      if (!current || seen.has(current)) break
      seen.add(current)
      const dir = path.join(current, "reports")
      if (fs.existsSync(dir)) {
        try {
          const names = fs.readdirSync(dir).filter((name) => reportName.test(name))
          if (names.length) return dir
        } catch {
          // Keep looking. A missing or unreadable folder is not a report source.
        }
      }
      const parent = path.dirname(current)
      if (parent === current) break
      current = parent
    }
  }
  return ""
}

function listNames(dir) {
  return fs
    .readdirSync(dir)
    .filter((name) => reportName.test(name))
    .sort()
    .reverse()
}

exports.handler = async function handler(event) {
  try {
    if (!event || event.httpMethod !== "GET") {
      return json(405, { error: "Unable to load report. Please try again." })
    }

    const params = event.queryStringParameters || {}
    const requestedName = String(params.name || "")
    const requestedDate = String(params.date || "")
    let name = requestedName
    if (!name && requestedDate) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(requestedDate)) {
        return json(400, { error: "Unable to load report. Please try again." })
      }
      name = `courses-${requestedDate}.txt`
    }

    const dir = findReportsDir()
    if (!name) {
      return json(200, { reports: dir ? listNames(dir) : [] })
    }
    if (!reportName.test(name) || path.basename(name) !== name) {
      return json(400, { error: "Unable to load report. Please try again." })
    }
    if (!dir) return json(404, { error: "Unable to load report. Please try again." })

    const filePath = path.join(dir, name)
    if (!filePath.startsWith(`${dir}${path.sep}`) || !fs.existsSync(filePath)) {
      return json(404, { error: "Unable to load report. Please try again." })
    }
    return json(200, { name, text: fs.readFileSync(filePath, "utf8") })
  } catch {
    return json(500, { error: "Unable to load report. Please try again." })
  }
}
