"""Send each transcription to the AI and classify the booking result."""

from __future__ import annotations

import http.client
import json
import os
import re
import threading
import time
from urllib.parse import urlparse

CATEGORIES = (
    "Booking Successful",
    "Slot Unavailable",
    "Customer Abandoned",
    "Voice Recognition Issue",
    "Agent Misunderstood Customer",
    "Customer Disconnected",
    "Payment Issue",
    "Technical/API Issue",
    "Course/Availability Issue",
    "Other",
    "Unclear",
)

FAILURE_POINT_CATEGORIES = (
    "Silent after greeting",
    "Caller ended before giving a date",
    "Requested tee time unavailable",
    "Caller rejected the price",
    "Caller asked to transfer to pro shop",
    "Tool or API error",
    "Voice not understood",
    "Missing or invalid information",
    "Other",
    "Root cause cannot be confirmed",
)

BOOKING_STATUSES = (
    "Booking Successful",
    "Booking Not Completed",
    "Unclear",
)

FAILURE_REASONS = (
    "Tee Time Unavailable",
    "Customer Rejected Alternative Time",
    "Date/Time Issue",
    "Player Count Issue",
    "AI Misunderstanding",
    "Voice Recognition Issue",
    "Call Disconnected",
    "Technical/API Issue",
    "Payment Issue",
    "Transfer Issue",
    "Customer Changed Mind",
    "Customer Abandoned",
    "Information Only",
    "Other",
    "Unclear",
)

DROP_OFF_STAGES = (
    "Greeting",
    "Date Selection",
    "Player Count",
    "Tee Time Selection",
    "Rate Confirmation",
    "Customer Details",
    "Payment",
    "Booking Confirmation",
    "Transfer to Pro Shop",
    "Completed",
    "Unclear",
)


def _unclear(conversation: dict, reason: str) -> dict:
    confirmed = "Root cause cannot be confirmed"
    return {
        "conversation_id": conversation.get("id"),
        "call_id": conversation.get("call_id"),
        "booking_successful": False,
        "category": "Unclear",
        "drop_off_stage": "Unclear",
        "failure_reason": reason,
        "summary": reason,
        "evidence": "",
        "conversation_summary": reason,
        "failure_point_category": "Root cause cannot be confirmed",
        "failure_point": "Root cause cannot be confirmed. The stopping step is not in the transcript.",
        "what_happened": reason,
        "confirmed_failure_reason": confirmed,
        "why_booking_did_not_happen": reason,
        "possible_cause": "",
        "final_root_cause": f"{confirmed}. {reason}",
    }


def _normalize_category(value: str | None) -> str:
    if not value:
        return "Unclear"
    cleaned = value.strip()
    for category in CATEGORIES:
        if cleaned.lower() == category.lower():
            return category
    return "Other"


def _normalize_failure_point_category(value: str | None) -> str:
    if not value:
        return "Root cause cannot be confirmed"
    cleaned = value.strip()
    for category in FAILURE_POINT_CATEGORIES:
        if cleaned.lower() == category.lower():
            return category
    return "Other"


def _normalize_stage(value: str | None, booking_successful: bool) -> str:
    if booking_successful:
        return "Completed"
    if not value:
        return "Unclear"
    cleaned = value.strip()
    for stage in DROP_OFF_STAGES:
        if cleaned.lower() == stage.lower():
            return stage
    if len(cleaned) > 60:
        return "Unclear"
    return cleaned


def _extract_json(text: str) -> dict:
    stripped = text.strip()
    fence = re.search(r"```(?:json)?\s*(.*?)```", stripped, re.DOTALL)
    if fence:
        stripped = fence.group(1).strip()
    start = stripped.find("{")
    end = stripped.rfind("}")
    if start == -1 or end == -1 or end <= start:
        raise ValueError("AI response did not contain a JSON object.")
    parsed = json.loads(stripped[start : end + 1])
    if not isinstance(parsed, dict):
        raise ValueError("AI response JSON was not an object.")
    return parsed


_HTTP = threading.local()
_RETRYABLE = {429, 500, 502, 503, 504}


def _reset_connection() -> None:
    connection = getattr(_HTTP, "connection", None)
    if connection is not None:
        try:
            connection.close()
        except Exception:
            pass
    _HTTP.connection = None
    _HTTP.target = None


def _connection(host: str, port: int) -> http.client.HTTPSConnection:
    target = (host, port)
    connection = getattr(_HTTP, "connection", None)
    if connection is None or getattr(_HTTP, "target", None) != target:
        _reset_connection()
        connection = http.client.HTTPSConnection(host, port, timeout=90)
        _HTTP.connection = connection
        _HTTP.target = target
    return connection


def _post_json(url: str, payload: bytes, headers: dict) -> tuple[int, bytes, float]:
    parsed = urlparse(url)
    host = parsed.hostname or ""
    port = parsed.port or 443
    path = parsed.path or "/"
    if parsed.query:
        path = f"{path}?{parsed.query}"
    connection = _connection(host, port)
    try:
        connection.request("POST", path, body=payload, headers=headers)
        response = connection.getresponse()
        body = response.read()
    except Exception:
        _reset_connection()
        raise
    retry_after = 0.0
    raw_wait = response.getheader("Retry-After")
    if raw_wait:
        try:
            retry_after = float(raw_wait)
        except ValueError:
            retry_after = 0.0
    if response.status >= 400:
        _reset_connection()
    return response.status, body, retry_after


def _chat(messages: list[dict]) -> str:
    api_key = os.environ.get("AI_API_KEY", "")
    if not api_key:
        raise RuntimeError("Missing AI_API_KEY in .env.")
    base_url = os.environ.get("AI_BASE_URL", "https://api.openai.com/v1").rstrip("/")
    model = os.environ.get("AI_MODEL", "gpt-4o-mini")
    payload = json.dumps(
        {
            "model": model,
            "temperature": 0,
            "messages": messages,
        }
    ).encode("utf-8")
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "Connection": "keep-alive",
    }
    delay = 1.0
    last_detail = ""
    for attempt in range(4):
        try:
            status, raw_body, retry_after = _post_json(
                f"{base_url}/chat/completions",
                payload,
                headers,
            )
        except OSError as error:
            last_detail = str(error)
            if attempt == 3:
                break
            time.sleep(delay)
            delay = min(delay * 2, 8)
            continue
        if status == 200:
            try:
                body = json.loads(raw_body.decode("utf-8"))
                return body["choices"][0]["message"]["content"]
            except (KeyError, IndexError, TypeError, json.JSONDecodeError) as error:
                raise RuntimeError("AI API response did not include a message.") from error
        detail = raw_body.decode("utf-8", errors="replace")[:500]
        last_detail = f"{status}: {detail}"
        if status not in _RETRYABLE or attempt == 3:
            raise RuntimeError(f"AI API request failed ({last_detail})")
        time.sleep(retry_after or delay)
        delay = min(delay * 2, 8)
    raise RuntimeError(f"AI API request failed ({last_detail})")


def _clip(value: str, limit: int = 500) -> str:
    text = re.sub(r"https?://\S+", "[url omitted]", value or "")
    text = " ".join(text.split())
    if len(text) <= limit:
        return text
    return text[: limit - 3] + "..."


def message_timeline(messages) -> str:
    """Compact customer, assistant, and tool sequence. Recording URLs are omitted."""
    if isinstance(messages, str):
        try:
            messages = json.loads(messages)
        except json.JSONDecodeError:
            return "(message log could not be read)"
    if not isinstance(messages, list) or not messages:
        return "(no message log)"

    lines = []
    for index, message in enumerate(messages, start=1):
        if not isinstance(message, dict):
            continue
        role = str(message.get("role") or "unknown")
        timestamp = str(message.get("timestamp") or "")
        content = message.get("content") or ""
        if not isinstance(content, str):
            content = json.dumps(content)
        parts = [f"{index}. {timestamp} {role}: {_clip(content)}"]
        tool_id = message.get("tool_call_id")
        if tool_id:
            parts.append(f"tool_result_id={tool_id}")
        for call in message.get("tool_calls") or []:
            if not isinstance(call, dict):
                continue
            function = call.get("function") or {}
            name = function.get("name") or "unknown_tool"
            arguments = function.get("arguments") or ""
            if not isinstance(arguments, str):
                arguments = json.dumps(arguments)
            parts.append(f"tool={name} arguments={_clip(arguments, 400)}")
        lines.append(" | ".join(parts))
    timeline = "\n".join(lines)
    if len(timeline) > 12000:
        return timeline[:11997] + "..."
    return timeline or "(no message log)"


def _message_log(conversation: dict) -> str:
    """Build the message log once. Later reads reuse that text."""
    cached = conversation.get("message_log")
    if isinstance(cached, str):
        return cached
    log = message_timeline(conversation.get("messages"))
    conversation["message_log"] = log
    return log


def _context(conversation: dict) -> str:
    cached = conversation.get("analysis_context")
    if isinstance(cached, str):
        return cached
    booking = conversation.get("booking_data") or {}
    lines = [
        f"conversation_id: {conversation.get('id')}",
        f"call_id: {conversation.get('call_id')}",
        f"created_at: {conversation.get('created_at')}",
        f"end_call_reason: {conversation.get('end_call_reason') or ''}",
        f"hasbooking: {conversation.get('hasbooking')}",
        f"call_outcome: {conversation.get('call_outcome') or ''}",
        f"booking_status: {booking.get('booking_status') or ''}",
        f"tee_booking_confirmed: {booking.get('tee_booking_confirmed') or ''}",
        "",
        "TRANSCRIPT:",
        conversation.get("transcript") or "",
        "",
        "MESSAGE LOG:",
        _message_log(conversation),
    ]
    text = "\n".join(lines)
    conversation["analysis_context"] = text
    return text


_COURSE_SYSTEM = (
    "You analyze one full golf tee-time voice conversation. "
    "Read the transcript and MESSAGE LOG from start to finish before you decide. "
    "Use only that evidence. Do not treat end_call_reason, call_outcome, or booking labels as proof. "
    "Explain why the golfer did not leave with a completed booking. "
    "Use the golfer's request: date, time, player count, holes, player type, "
    "availability, alternatives, price, payment, and confirmation details. "
    "failure_reason must be exactly one of: "
    + ", ".join(FAILURE_REASONS)
    + ". "
    "Put the specific detail in what_happened, not in failure_reason. "
    "A silent call, or a hang-up before the customer made a request, is Unclear. "
    "Booking Successful only when a booking was actually completed in the transcript or a tool result. "
    "If the evidence is not enough, set booking_status and failure_reason to Unclear. "
    "booking_status must be one of: "
    + ", ".join(BOOKING_STATUSES)
    + ". drop_off_stage must be one of: "
    + ", ".join(DROP_OFF_STAGES)
    + ". "
    "Return JSON with keys booking_status, failure_reason, drop_off_stage, "
    "what_happened, why_not_completed. "
    "what_happened covers the request, what was offered, and what stopped the booking. "
    "why_not_completed is one sentence naming the same cause as failure_reason. "
    "Leave failure_reason and why_not_completed empty when booking_status is Booking Successful, "
    "and set drop_off_stage to Completed."
)


def analyze_conversation(conversation: dict) -> dict:
    transcript = (conversation.get("transcript") or "").strip()
    if not transcript:
        return _unclear(
            conversation,
            "No transcription was stored, so the booking result cannot be determined.",
        )

    system = (
        "You analyze golf tee-time voice booking transcripts for a QA bug report. "
        "Use only the transcript and MESSAGE LOG as evidence. "
        "end_call_reason, call_outcome, and booking fields are labels. "
        "Do not treat a label as proof if the transcript and message log do not support it. "
        "Do not guess. If the evidence does not prove a cause, set confirmed_failure_reason "
        "and final_root_cause to exactly 'Root cause cannot be confirmed' and name the "
        "missing evidence in possible_cause. Keep a possible cause separate from a confirmed cause. "
        "Choose exactly one category from this list: "
        + ", ".join(CATEGORIES)
        + ". Choose a drop-off stage from this list when it fits: "
        + ", ".join(DROP_OFF_STAGES)
        + ". Booking Successful only when the transcript or a tool result shows the booking "
        "was actually completed. "
        "Choose exactly one failure_point_category from this list: "
        + ", ".join(FAILURE_POINT_CATEGORIES)
        + ". "
        "Return JSON with keys booking_successful (boolean), category, drop_off_stage, "
        "failure_reason, summary, evidence, conversation_summary, failure_point_category, "
        "failure_point, what_happened, confirmed_failure_reason, why_booking_did_not_happen, "
        "possible_cause, final_root_cause. "
        "failure_reason is one sentence. "
        "failure_point is one sentence in this shape: "
        "After [last completed step], [who] [what stopped the booking]. "
        "Name the last customer, assistant, or tool step from the transcript or message log. "
        "Do not set failure_point to only a stage name such as Greeting, Date Selection, or Unknown. "
        "If the stopping step is not in the log, set failure_point_category and failure_point "
        "to 'Root cause cannot be confirmed' and say which step is missing. "
        "what_happened is the step-by-step sequence of customer, assistant, and tool results. "
        "evidence is a short quote from the transcript or message log. "
        "possible_cause is empty when nothing beyond the confirmed reason is suggested."
    )
    raw = _chat(
        [
            {"role": "system", "content": system},
            {"role": "user", "content": _context(conversation)},
        ]
    )
    try:
        parsed = _extract_json(raw)
    except (json.JSONDecodeError, ValueError):
        return _unclear(
            conversation,
            "The AI response could not be read, so this conversation was not classified.",
        )

    category = _normalize_category(parsed.get("category"))
    booking_successful = category == "Booking Successful"
    stage = _normalize_stage(
        str(parsed.get("drop_off_stage") or ""),
        booking_successful,
    )
    failure_reason = str(parsed.get("failure_reason") or "").strip()
    summary = str(parsed.get("summary") or "").strip()
    evidence = str(parsed.get("evidence") or "").strip()
    confirmed = str(parsed.get("confirmed_failure_reason") or "").strip()
    final_root = str(parsed.get("final_root_cause") or "").strip()
    if category == "Unclear" and not failure_reason:
        failure_reason = "The transcript does not provide enough information."
    if not confirmed:
        confirmed = failure_reason or "Root cause cannot be confirmed"
    if not final_root:
        final_root = confirmed
    if booking_successful:
        failure_reason = ""
        stage = "Completed"
        confirmed = ""
        final_root = ""
    return {
        "conversation_id": conversation.get("id"),
        "call_id": conversation.get("call_id"),
        "booking_successful": booking_successful,
        "category": category,
        "drop_off_stage": stage,
        "failure_reason": failure_reason,
        "summary": summary or failure_reason,
        "evidence": evidence,
        "conversation_summary": str(parsed.get("conversation_summary") or summary or failure_reason).strip(),
        "failure_point_category": _normalize_failure_point_category(
            str(parsed.get("failure_point_category") or "")
        ),
        "failure_point": str(parsed.get("failure_point") or "").strip(),
        "what_happened": str(parsed.get("what_happened") or "").strip(),
        "confirmed_failure_reason": confirmed,
        "why_booking_did_not_happen": str(parsed.get("why_booking_did_not_happen") or "").strip(),
        "possible_cause": str(parsed.get("possible_cause") or "").strip(),
        "final_root_cause": final_root,
    }


def _normalize_booking_status(value: str | None) -> str:
    cleaned = (value or "").strip()
    for status in BOOKING_STATUSES:
        if cleaned.lower() == status.lower():
            return status
    return "Unclear"


_REASON_RULES = (
    (("payment", "credit card"), "Payment Issue"),
    (("not understood", "could not understand", "voice recognition", "misheard"), "Voice Recognition Issue"),
    (("misunderstand",), "AI Misunderstanding"),
    (
        (
            "system error",
            "system did not",
            "lookup error",
            "tee sheet",
            "availability error",
            "booking system",
            "failed validation",
            "invalid last name",
            "could not be applied",
            "duplicate booking",
            "never confirmed",
            "complete transaction",
            "processing never",
        ),
        "Technical/API Issue",
    ),
    (
        (
            "group size",
            "group booking",
            "group required",
            "large group",
            "single-player",
            "single player",
            "player count",
            "player type",
            "six-player",
            "junior group",
        ),
        "Player Count Issue",
    ),
    (
        (
            "outside booking",
            "booking window",
            "too soon",
            "too close",
            "too far",
            "date unavailable",
            "date only",
            "date selection",
            "time not provided",
            "did not specify tee",
            "tee time not specified",
            "did not provide tee",
            "not provide booking details",
        ),
        "Date/Time Issue",
    ),
    (
        (
            "with buddy",
            "deferred",
            "callback",
            "declined the rate",
            "declined available rate",
            "declined after",
            "lower rate",
            "rate comparison",
            "changed mind",
        ),
        "Customer Changed Mind",
    ),
    (
        (
            "alternative",
            "declined offered",
            "declined available",
            "declined the later",
            "declined booking",
            "declined to finalize",
            "declined another",
        ),
        "Customer Rejected Alternative Time",
    ),
    (
        ("unavailable", "9 hole", "nine hole", "nine-hole", "no tee", "no availability"),
        "Tee Time Unavailable",
    ),
    (
        (
            "information only",
            "course information",
            "rate information",
            "pricing only",
            "event information",
            "aeration",
            "account credit",
            "staff availability",
            "non-booking",
            "non-golf",
        ),
        "Information Only",
    ),
    (("hung up", "hang up", "disconnect", "call ended"), "Call Disconnected"),
    (
        (
            "ended before",
            "abandoned",
            "did not confirm",
            "did not choose",
            "did not select",
            "did not finish",
            "no booking request",
            "did not make a tee",
            "did not request",
            "gave no booking",
            "before making request",
        ),
        "Customer Abandoned",
    ),
    (
        (
            "transfer",
            "pro shop",
            "representative",
            "operator",
            "golf shop",
            "human",
            "a person",
            "someone",
            "somebody",
            "attendant",
            "receptionist",
            "front desk",
            "clubhouse",
            "customer service",
            "live agent",
            "live person",
        ),
        "Transfer Issue",
    ),
)


def canonical_failure_reason(value: str | None) -> str:
    """Map any failure phrase onto the fixed FAILURE_REASONS list."""
    cleaned = " ".join((value or "").split()).strip(" .")
    if not cleaned:
        return "Unclear"
    for reason in FAILURE_REASONS:
        if cleaned.lower() == reason.lower():
            return reason
    text = cleaned.lower()
    if "unclear" in text:
        return "Unclear"
    for phrases, reason in _REASON_RULES:
        if any(phrase in text for phrase in phrases):
            return reason
    return "Other"


def _normalize_failure_reason(value: str | None, booking_status: str) -> str:
    if booking_status == "Booking Successful":
        return ""
    return canonical_failure_reason(value)


def _course_unclear(conversation: dict, reason: str) -> dict:
    return {
        "conversation_id": conversation.get("id"),
        "call_id": conversation.get("call_id"),
        "course_name": conversation.get("course_name") or "",
        "created_at": conversation.get("created_at"),
        "booking_status": "Unclear",
        "failure_reason": "Unclear",
        "drop_off_stage": "Unclear",
        "what_happened": reason,
        "why_not_completed": reason,
    }


def _reason_from_same_analysis(what_happened: str, why_not_completed: str) -> str:
    """Name a specific reason from the analysis already produced.

    This does not send the transcript or message log again.
    """
    summary = "\n".join(
        line
        for line in (
            f"what_happened: {what_happened}" if what_happened else "",
            f"why_not_completed: {why_not_completed}" if why_not_completed else "",
        )
        if line
    )
    if not summary:
        return "Unclear"
    try:
        raw = _chat(
            [
                {
                    "role": "system",
                    "content": (
                        "Choose the failure_reason from this list only: "
                        + ", ".join(FAILURE_REASONS)
                        + ". Use only the analysis below. "
                        "Return JSON with one key: failure_reason."
                    ),
                },
                {"role": "user", "content": summary},
            ]
        )
        parsed = _extract_json(raw)
    except (RuntimeError, json.JSONDecodeError, ValueError):
        return "Unclear"
    reason = _normalize_failure_reason(
        str(parsed.get("failure_reason") or ""),
        "Booking Not Completed",
    )
    return reason or "Unclear"


def course_evidence(conversation: dict) -> str:
    """Transcript and message log sent to the model. Built once per call."""
    cached = conversation.get("course_evidence")
    if isinstance(cached, str):
        return cached
    booking = conversation.get("booking_data") or {}
    text = "\n".join(
        [
            f"end_call_reason: {conversation.get('end_call_reason') or ''}",
            f"hasbooking: {conversation.get('hasbooking')}",
            f"call_outcome: {conversation.get('call_outcome') or ''}",
            f"booking_status: {booking.get('booking_status') or ''}",
            f"tee_booking_confirmed: {booking.get('tee_booking_confirmed') or ''}",
            "",
            "TRANSCRIPT:",
            conversation.get("transcript") or "",
            "",
            "MESSAGE LOG:",
            _message_log(conversation),
        ]
    )
    conversation["course_evidence"] = text
    return text


def analyze_course_conversation(conversation: dict) -> dict:
    """Classify one call from the full transcript and message log."""
    transcript = (conversation.get("transcript") or "").strip()
    messages = conversation.get("messages") or []
    if not transcript and not messages:
        return _course_unclear(
            conversation,
            "No transcription or message log was stored, so the booking result cannot be determined.",
        )

    context = course_evidence(conversation)
    try:
        raw = _chat(
            [
                {"role": "system", "content": _COURSE_SYSTEM},
                {"role": "user", "content": context},
            ]
        )
        parsed = _extract_json(raw)
    except (RuntimeError, json.JSONDecodeError, ValueError):
        return _course_unclear(
            conversation,
            "The AI response could not be read, so this conversation was not classified.",
        )

    booking_status = _normalize_booking_status(str(parsed.get("booking_status") or ""))
    failure_reason = _normalize_failure_reason(
        str(parsed.get("failure_reason") or ""),
        booking_status,
    )
    what_happened = str(parsed.get("what_happened") or "").strip()
    why_not_completed = str(parsed.get("why_not_completed") or "").strip()
    if booking_status == "Booking Not Completed" and not failure_reason:
        failure_reason = _reason_from_same_analysis(what_happened, why_not_completed)
    stage = _normalize_stage(
        str(parsed.get("drop_off_stage") or ""),
        booking_status == "Booking Successful",
    )
    if booking_status == "Booking Successful":
        failure_reason = ""
        why_not_completed = ""
        stage = "Completed"
    elif not what_happened:
        what_happened = "The transcript does not show a complete booking sequence."
    if booking_status != "Booking Successful" and not why_not_completed:
        why_not_completed = failure_reason or "The booking was not completed."
    return {
        "conversation_id": conversation.get("id"),
        "call_id": conversation.get("call_id"),
        "course_name": conversation.get("course_name") or "",
        "created_at": conversation.get("created_at"),
        "booking_status": booking_status,
        "failure_reason": failure_reason,
        "drop_off_stage": stage,
        "what_happened": what_happened,
        "why_not_completed": why_not_completed,
    }


def summarize_results(analyses: list[dict], course_name: str) -> str:
    unsuccessful = [item for item in analyses if not item["booking_successful"]]
    if not analyses:
        return "No conversations were available to summarize."
    if not unsuccessful:
        return "Every analyzed conversation completed a booking."

    compact = [
        {
            "category": item["category"],
            "drop_off_stage": item["drop_off_stage"],
            "failure_reason": item["failure_reason"],
        }
        for item in unsuccessful
    ]
    system = (
        "Write one short paragraph for an operations report. "
        "Use only the JSON counts and reasons you are given. "
        "Do not invent causes that are not in the input. "
        "Name the most common failure and the main drop-off stage."
    )
    user = (
        f"Course: {course_name}\n"
        f"Unsuccessful conversations: {len(unsuccessful)} of {len(analyses)}\n"
        f"{json.dumps(compact)}"
    )
    text = _chat(
        [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ]
    ).strip()
    return " ".join(text.split())
