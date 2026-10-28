const fs = require("node:fs")
const path = require("node:path")

const REASON_NOT_AVAILABLE = "Reason not available"
const OUTCOMES = ["booked", "saved", "unknown"]
const MAX_PAGE_SIZE = 20000
const reasonShards = new Map()
let loaded = null

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

function findDataDir() {
  const starts = [process.cwd(), __dirname]
  const seen = new Set()
  for (const start of starts) {
    let current = start
    for (let depth = 0; depth < 8; depth += 1) {
      if (!current || seen.has(current)) break
      seen.add(current)
      const candidates = [
        path.join(current, "flow-data"),
        path.join(current, "netlify", "flow-data"),
      ]
      for (const dir of candidates) {
        if (fs.existsSync(path.join(dir, "flow.json")) && fs.existsSync(path.join(dir, "calls.json"))) return dir
      }
      const parent = path.dirname(current)
      if (parent === current) break
      current = parent
    }
  }
  return ""
}

function loadData() {
  if (loaded) return loaded
  const dir = findDataDir()
  if (!dir) return null
  loaded = {
    dir,
    flow: JSON.parse(fs.readFileSync(path.join(dir, "flow.json"), "utf8")),
    calls: JSON.parse(fs.readFileSync(path.join(dir, "calls.json"), "utf8")),
  }
  return loaded
}

function savedReason(dir, callId) {
  const shard = /^[0-9a-z]{2}/.test(callId.toLowerCase()) ? callId.slice(0, 2).toLowerCase() : "_"
  if (!reasonShards.has(shard)) {
    const file = path.join(dir, "reasons", `${shard}.json`)
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

function queryOf(event) {
  if (event && typeof event.url === "string" && event.httpMethod == null && event.queryStringParameters == null) {
    return new URL(event.url).searchParams
  }
  return new URLSearchParams((event && event.queryStringParameters) || {})
}

function listCalls(data, params) {
  const { flow, calls, dir } = data
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
    const saved = outcomeCode === 1 ? savedReason(dir, callId) : null
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

exports.handler = async function handler(event) {
  const method = (event && (event.httpMethod || event.requestContext?.http?.method)) || "GET"
  if (method !== "GET") return json(405, { error: "Calls could not be read." })
  try {
    const data = loadData()
    if (!data) return json(404, { error: "Calls could not be read." })
    return json(200, listCalls(data, queryOf(event)))
  } catch {
    return json(500, { error: "Calls could not be read." })
  }
}

exports.config = {
  path: "/api/calls",
}
