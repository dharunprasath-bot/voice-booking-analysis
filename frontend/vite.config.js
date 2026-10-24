import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const reportsDir = path.join(root, "reports")
const pythonBin = path.join(root, ".venv", "bin", "python")
const reportName = /^courses-(\d{4}-\d{2}-\d{2})\.txt$/
const flowDir = path.join(root, ".flow-cache")
const REASON_NOT_AVAILABLE = "Reason not available"
const OUTCOMES = ["booked", "saved", "unknown"]
const MAX_PAGE_SIZE = 20000
let runInProgress = false
let flowCache = null
let flowRequest = null
const reasonShards = new Map()

function sendJson(res, status, body) {
  res.statusCode = status
  res.setHeader("Content-Type", "application/json")
  res.end(JSON.stringify(body))
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on("data", (chunk) => chunks.push(chunk))
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8")
      if (!raw) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(raw))
      } catch (error) {
        reject(error)
      }
    })
    req.on("error", reject)
  })
}

function listReports() {
  if (!fs.existsSync(reportsDir)) return []
  return fs
    .readdirSync(reportsDir)
    .filter((name) => reportName.test(name))
    .sort()
    .reverse()
}

function reportPath(name) {
  if (!reportName.test(name)) return null
  const full = path.join(reportsDir, name)
  if (!full.startsWith(reportsDir + path.sep)) return null
  return full
}

function runPython(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(pythonBin, ["backend/main.py", ...args], {
      cwd: root,
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8")
    })
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8")
    })
    child.on("error", reject)
    child.on("close", (code) => resolve({ code, stdout, stderr }))
  })
}

function readFlowCache() {
  const flowText = fs.readFileSync(path.join(flowDir, "flow.json"), "utf8")
  const calls = JSON.parse(fs.readFileSync(path.join(flowDir, "calls.json"), "utf8"))
  reasonShards.clear()
  return { flowText, flow: JSON.parse(flowText), calls }
}

function loadFlow(refresh = false) {
  if (flowCache && !refresh) return Promise.resolve(flowCache)
  if (flowRequest) return flowRequest
  flowRequest = (async () => {
    try {
      if (refresh || !fs.existsSync(path.join(flowDir, "flow.json")) || !fs.existsSync(path.join(flowDir, "calls.json"))) {
        const { code, stderr } = await runPython(["--flow"])
        if (code !== 0 && !fs.existsSync(path.join(flowDir, "flow.json"))) {
          throw new Error(stderr.trim() || `The flow build exited with code ${code}.`)
        }
      }
      flowCache = readFlowCache()
      return flowCache
    } finally {
      flowRequest = null
    }
  })()
  return flowRequest
}

function savedReason(callId) {
  const shard = /^[0-9a-z]{2}/.test(callId.toLowerCase()) ? callId.slice(0, 2).toLowerCase() : "_"
  if (!reasonShards.has(shard)) {
    const file = path.join(flowDir, "reasons", `${shard}.json`)
    reasonShards.set(shard, fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {})
  }
  return reasonShards.get(shard)[callId] || null
}

function groupMatches(group, wanted) {
  if (!wanted || wanted === "all") return true
  if (wanted === "UNCLASSIFIED") return group.key === "UNCLASSIFIED"
  if (wanted === "SCO" || wanted === "MCO") return group.kind === wanted
  return group.key === wanted
}

function listCalls({ flow, calls }, params) {
  const from = params.get("from") || ""
  const to = params.get("to") || ""
  const outcome = params.get("outcome") || "all"
  const reason = params.get("reason") || "all"
  const phone = params.get("phone") || ""
  const query = (params.get("q") || "").trim().toLowerCase()
  const page = Math.max(0, Number(params.get("page")) || 0)
  const size = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(params.get("size")) || 50))
  const groupOk = flow.groups.map((group) => groupMatches(group, params.get("group")))
  const dayOk = flow.days.map((day) => (!from || day >= from) && (!to || day <= to))
  const wantedOutcomes = outcome === "notbooked" ? [1, 2] : outcome === "all" ? [0, 1, 2] : [OUTCOMES.indexOf(outcome)]
  const reasonAt = reason === "all" ? null : reason === REASON_NOT_AVAILABLE ? -1 : flow.categories.indexOf(reason)
  const matched = []
  for (let index = 0; index < calls.callIds.length; index += 1) {
    if (!dayOk[calls.day[index]] || !groupOk[calls.group[index]]) continue
    if (!wantedOutcomes.includes(calls.outcome[index])) continue
    if (reasonAt !== null && (calls.outcome[index] === 0 || calls.category[index] !== reasonAt)) continue
    if (phone && flow.phones[calls.phone[index]] !== phone) continue
    if (query && !calls.callIds[index].toLowerCase().includes(query)) continue
    matched.push(index)
  }
  matched.sort((left, right) => {
    const byDay = flow.days[calls.day[right]].localeCompare(flow.days[calls.day[left]])
    return byDay || calls.ids[right] - calls.ids[left]
  })
  const rows = matched.slice(page * size, page * size + size).map((index) => {
    const group = flow.groups[calls.group[index]]
    const callId = calls.callIds[index]
    const outcomeCode = calls.outcome[index]
    const saved = outcomeCode === 1 ? savedReason(callId) : null
    return {
      conversationId: calls.ids[index],
      callId,
      date: flow.days[calls.day[index]],
      groupKey: group.key,
      kind: group.kind,
      courseId: group.id,
      courseName: group.name,
      phone: flow.phones[calls.phone[index]],
      hasTranscript: calls.transcript[index] === 1,
      outcome: OUTCOMES[outcomeCode],
      reason: outcomeCode === 0 ? "" : calls.category[index] >= 0 ? flow.categories[calls.category[index]] : REASON_NOT_AVAILABLE,
      whatHappened: saved ? saved[0] : "",
      whyNotCompleted: outcomeCode === 0 ? "" : saved ? saved[1] : REASON_NOT_AVAILABLE,
      linkedBooking: calls.linked[index] === 1,
    }
  })
  return { total: matched.length, page, size, calls: rows }
}

function reportApi() {
  return {
    name: "report-api",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url || "/", "http://localhost")
        if (url.pathname === "/api/flow" && req.method === "GET") {
          try {
            const { flowText } = await loadFlow(url.searchParams.get("refresh") === "1")
            res.statusCode = 200
            res.setHeader("Content-Type", "application/json")
            res.end(flowText)
          } catch (error) {
            sendJson(res, 500, { error: error.message || "The course flow could not be read." })
          }
          return
        }

        if (url.pathname === "/api/calls" && req.method === "GET") {
          try {
            sendJson(res, 200, listCalls(await loadFlow(), url.searchParams))
          } catch (error) {
            sendJson(res, 500, { error: error.message || "Calls could not be read." })
          }
          return
        }

        if (url.pathname === "/api/transcript" && req.method === "GET") {
          const callId = String(url.searchParams.get("callId") || "")
          if (!/^[\w-]{1,100}$/.test(callId)) {
            sendJson(res, 400, { error: "Pass a valid callId." })
            return
          }
          try {
            const { code, stdout, stderr } = await runPython(["--transcript", callId])
            const body = stdout.trim() ? JSON.parse(stdout) : { error: stderr.trim() || "Transcript not found." }
            sendJson(res, code === 0 ? 200 : 404, body)
          } catch (error) {
            sendJson(res, 500, { error: error.message || "Transcript could not be read." })
          }
          return
        }

        if (url.pathname === "/api/reports" && req.method === "GET") {
          const name = url.searchParams.get("name")
          if (!name) {
            sendJson(res, 200, { reports: listReports() })
            return
          }
          const full = reportPath(name)
          if (!full || !fs.existsSync(full)) {
            sendJson(res, 404, { error: "Report not found." })
            return
          }
          sendJson(res, 200, {
            name,
            text: fs.readFileSync(full, "utf8"),
          })
          return
        }

        if (url.pathname === "/api/run" && req.method === "POST") {
          const origin = req.headers.origin
          const sameOrigin = !origin || origin === `http://${req.headers.host}`
          const isJson = String(req.headers["content-type"] || "").startsWith("application/json")
          if (!sameOrigin || !isJson) {
            sendJson(res, 403, { error: "Request not allowed." })
            return
          }
          if (runInProgress) {
            sendJson(res, 409, { error: "A report is already running." })
            return
          }
          let body
          try {
            body = await readBody(req)
          } catch {
            sendJson(res, 400, { error: "Send a JSON body with a date." })
            return
          }
          const date = String(body.date || "")
          if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            sendJson(res, 400, { error: "Use a date in YYYY-MM-DD form." })
            return
          }
          if (!fs.existsSync(pythonBin)) {
            sendJson(res, 500, { error: "Project Python was not found at .venv/bin/python." })
            return
          }

          runInProgress = true
          res.writeHead(200, {
            "Content-Type": "application/x-ndjson; charset=utf-8",
            "Cache-Control": "no-cache",
          })
          const write = (message) => {
            res.write(`${JSON.stringify(message)}\n`)
          }
          write({ type: "status", text: `Running backend/main.py --date ${date}` })

          const child = spawn(pythonBin, ["backend/main.py", "--date", date], {
            cwd: root,
            env: { ...process.env, PYTHONUNBUFFERED: "1" },
          })
          let stderr = ""
          child.stderr.on("data", (chunk) => {
            stderr += chunk.toString("utf8")
            const lines = stderr.split(/\r?\n/)
            stderr = lines.pop() || ""
            for (const line of lines) {
              const text = line.trim()
              if (text) write({ type: "status", text })
            }
          })
          child.on("error", (error) => {
            runInProgress = false
            write({ type: "error", text: error.message })
            res.end()
          })
          child.on("close", (code) => {
            runInProgress = false
            const trailing = stderr.trim()
            if (trailing) write({ type: "status", text: trailing })
            if (code !== 0) {
              write({ type: "error", text: `The report command exited with code ${code}.` })
              res.end()
              return
            }
            const name = `courses-${date}.txt`
            const full = reportPath(name)
            if (!full || !fs.existsSync(full)) {
              write({ type: "error", text: "The command finished, but the report file was not written." })
              res.end()
              return
            }
            write({ type: "done", name, text: fs.readFileSync(full, "utf8") })
            res.end()
          })
          return
        }

        next()
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), reportApi()],
  server: {
    proxy: {},
  },
})
