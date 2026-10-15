const NEGATIVE = /\b(before|without|prior to|rather than|instead of|offered to|no|not|never|didn't|did not|unable to|has not|hasn't)\b/i

const FUNNEL = [
  ["Payment", /\b(payment details|card number|credit card|entered (?:a |the )?payment|payment page|collect(?:ed|ing) payment|paid the)\b/i],
  ["Booking Confirmation", /\b(booking (?:was )?confirmed|confirmation number|received (?:a |the )?confirmation|booking confirmation was)\b/i],
  ["Booking Review", /\b(reviewed the booking|booking summary|review(?:ed)? the (?:reservation|details))\b/i],
  ["Pricing & Fees", /\b(price|prices|rate|rates|quoted|green fee|total of \$|\$\d)/i],
  ["Tee Time Selection", /\b(offered (?:the |an |a )?(?:earliest |available )?(?:time|tee time)|presented (?:the )?(?:cheapest |available )?options|chose (?:a |the )?tee time|selected (?:a |the )?(?:tee )?time|available times)\b/i],
  ["Tee Time Search", /\b(checked availability|searched availability|found availability|looked up (?:a |the )?tee time|search(?:ed)? for (?:a |the )?tee time)\b/i],
  ["Player Details Collection", /\b(player(?:'s)? (?:name|email|phone)|collected (?:the )?player details|contact details)\b/i],
  ["Member Verification", /\b(member number|membership|verified (?:the )?member)\b/i],
  ["Player Type Selection", /\b(player type|regular player|public player|member rate)\b/i],
  ["Cart / Extras", /\b(cart fee|selected (?:a )?cart|asked about (?:a )?cart|club rental)\b/i],
  ["Player Count", /\b(player count|number of players|how many players|\d+ players|two players|four players|one player)\b/i],
  ["Hole Selection", /\b(9 holes|18 holes|number of holes|hole selection)\b/i],
  ["Date Selection", /\b(?:golfer|caller|customer).{0,50}\b(?:date|today|tomorrow)\b|\b(?:asked for|requested|specified).{0,24}\b(?:date|day|today|tomorrow)\b/i],
  ["Course Selection", /\b(which course|selected (?:the )?course|chose (?:the )?course|named (?:the )?course|on the .{0,40}course)\b/i],
  ["Intent Identification", /\b(asked to book|wanted to book|need to book|help booking|booking request)\b/i],
]

const ENDINGS = [
  ["Transfer to Pro Shop", /\b(transfer(?:red)?(?:\s+\w+){0,4}\s+to (?:the )?pro shop|asked to be transferred)\b/i],
  ["Cancellation", /\b(cancell(?:ed|ation|ing)|cancel(?:\s+\w+){0,3})\b/i],
  ["Rescheduling", /\b(reschedul\w*|move (?:the |an |a )?existing (?:tee time|booking))\b/i],
  ["Waitlist", /\b(waitlist|waiting list)\b/i],
]

function noteText(call) {
  return [call?.whatHappened, call?.whyNotCompleted].filter(Boolean).join(" ").replace(/\s+/g, " ").trim()
}

function mentionIsReached(text, pattern) {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`
  const matcher = new RegExp(pattern.source, flags)
  let match = matcher.exec(text)
  while (match) {
    const clause = text.slice(Math.max(0, match.index - 80), match.index).split(/[.!?]/).pop() || ""
    if (!NEGATIVE.test(clause)) return true
    match = matcher.exec(text)
  }
  return false
}

function dynamicStage(text) {
  const matcher = /\b(?:switched to asking about|moved the conversation to|ended while discussing|while discussing)\s+([^.,;]+)/gi
  let match = matcher.exec(text)
  while (match) {
    const clause = text.slice(Math.max(0, match.index - 80), match.index).split(/[.!?]/).pop() || ""
    const words = match[1].split(/\b(?:instead|before|and)\b/i)[0].trim().split(/\s+/).slice(0, 4)
    if (!NEGATIVE.test(clause) && words.length && !/^(the|a|an)$/i.test(words[0])) {
      return words.join(" ").replace(/\b\w/g, (letter) => letter.toUpperCase())
    }
    match = matcher.exec(text)
  }
  return ""
}

export function abandonedStage(call) {
  const text = noteText(call)
  if (!text || /^not stated\.?$/i.test(text)) return "Unknown"
  for (const [stage, pattern] of ENDINGS) {
    if (mentionIsReached(text, pattern)) return stage
  }
  const named = dynamicStage(text)
  if (named) return named
  for (const [stage, pattern] of FUNNEL) {
    if (mentionIsReached(text, pattern)) return stage
  }
  if (/\b(did not respond|never responded|no request|before making a (?:booking )?request|long silences?|only (?:the )?greeting|ended immediately after)\b/i.test(text)) {
    return "Before Booking"
  }
  return "Unknown"
}

export function groupAbandonedCalls(calls) {
  const groups = new Map()
  for (const call of calls || []) {
    const stage = abandonedStage(call)
    const rows = groups.get(stage)
    if (rows) rows.push(call)
    else groups.set(stage, [call])
  }
  return [...groups.entries()]
    .map(([stage, stageCalls]) => ({ stage, calls: stageCalls }))
    .sort((left, right) => {
      if (right.calls.length !== left.calls.length) return right.calls.length - left.calls.length
      return left.stage.localeCompare(right.stage)
    })
}
