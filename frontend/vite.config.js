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
let runInProgress = false

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

function reportApi() {
  return {
    name: "report-api",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url || "/", "http://127.0.0.1")
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
          write({ type: "status", text: `Running main.py --date ${date}` })

          const child = spawn(pythonBin, ["main.py", "--date", date], {
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
