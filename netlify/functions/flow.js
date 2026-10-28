const fs = require("node:fs")
const path = require("node:path")

function json(statusCode, body, raw) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
    body: raw ? body : JSON.stringify(body),
  }
}

function findFlowFile() {
  const starts = [process.cwd(), __dirname]
  const seen = new Set()
  for (const start of starts) {
    let current = start
    for (let depth = 0; depth < 8; depth += 1) {
      if (!current || seen.has(current)) break
      seen.add(current)
      const candidates = [
        path.join(current, "flow-data", "flow.json"),
        path.join(current, "netlify", "flow-data", "flow.json"),
      ]
      for (const file of candidates) {
        if (fs.existsSync(file) && fs.statSync(file).isFile()) return file
      }
      const parent = path.dirname(current)
      if (parent === current) break
      current = parent
    }
  }
  return ""
}

exports.handler = async function handler(event) {
  const method = (event && (event.httpMethod || event.requestContext?.http?.method)) || "GET"
  if (method !== "GET") return json(405, { error: "Unable to load report. Please try again." })
  try {
    const file = findFlowFile()
    if (!file) return json(404, { error: "Unable to load report. Please try again." })
    return json(200, fs.readFileSync(file, "utf8"), true)
  } catch {
    return json(500, { error: "Unable to load report. Please try again." })
  }
}

exports.config = {
  path: "/api/flow",
}
