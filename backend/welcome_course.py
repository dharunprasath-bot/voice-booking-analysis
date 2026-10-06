"""Identify a course from the assistant welcome message.

The spoken name is normalized against official golf_courses names when one
name is clearly the same club. A call with no welcome stays Unknown Course.
"""

from __future__ import annotations

import re

UNKNOWN_COURSE = "Unknown Course"

_PREFIXES = (
    "golf concierge at ",
    "thank you for calling ",
    "thanks for calling ",
    "welcome back to ",
    "welcome to ",
    "again at ",
    "back at ",
    "bienvenue à ",
    "bienvenue a ",
    "concierge de golf à ",
    "concierge de golf a ",
)

_TAIL = re.compile(
    r"\b(after-hours|ai concierge|i['’]?m here|i hope|hope you|can i help)\b.*$",
    re.IGNORECASE,
)


def _key(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", value.lower()).strip()


def _clean_spoken(value: str) -> str:
    text = " ".join(value.split())
    text = _TAIL.sub("", text)
    text = re.sub(r"\s+(back|again)$", "", text.strip(" .,-"), flags=re.IGNORECASE)
    text = " ".join(text.split()).strip(" .,-")
    if len(text) < 4 or len(text) > 80 or not re.search(r"[A-Za-z]{3,}", text):
        return ""
    lowered = text.lower()
    if "tee time" in lowered or "tee-time" in lowered:
        return ""
    return text


def name_from_text(text: str) -> str | None:
    """Return the course named by a welcome sentence, when the sentence has one."""
    flat = " ".join((text or "").split())
    if not flat:
        return None
    lowered = flat.lower()
    for prefix in _PREFIXES:
        index = lowered.find(prefix)
        if index < 0:
            continue
        rest = flat[index + len(prefix) :]
        rest = re.split(r"[,;!?.—]", rest, maxsplit=1)[0]
        cleaned = _clean_spoken(rest)
        if cleaned:
            return cleaned
    return None


def spoken_course_name(conversation: dict) -> str | None:
    """Use the first assistant message that actually names a course."""
    for message in conversation.get("messages") or []:
        if not isinstance(message, dict) or message.get("role") != "assistant":
            continue
        content = message.get("content") or ""
        if not isinstance(content, str):
            continue
        found = name_from_text(content)
        if found:
            return found
    transcript = conversation.get("transcript") or ""
    return name_from_text(transcript[:800])


def match_official_name(spoken: str, official_names: list[str]) -> str | None:
    """Map a spoken name to one official name when the match is unique."""
    spoken_key = _key(spoken)
    if len(spoken_key) < 6:
        return None
    exact = [name for name in official_names if _key(name) == spoken_key]
    if len(exact) == 1:
        return exact[0]
    if len(exact) > 1:
        return None

    matches = []
    for name in official_names:
        official_key = _key(name)
        if official_key.startswith(spoken_key + " "):
            matches.append(name)
        elif spoken_key.startswith(official_key + " ") and len(official_key) >= 8:
            matches.append(name)
    if len(matches) == 1:
        return matches[0]
    return None


def _same_club(left: str, right: str) -> bool:
    left_key = _key(left)
    right_key = _key(right)
    return (
        left_key == right_key
        or left_key.startswith(right_key + " ")
        or right_key.startswith(left_key + " ")
    )


def _prefer_name(current: str, candidate: str, official_names: list[str]) -> str:
    official_keys = {_key(name) for name in official_names}
    current_official = _key(current) in official_keys
    candidate_official = _key(candidate) in official_keys
    if candidate_official and not current_official:
        return candidate
    if current_official and not candidate_official:
        return current
    if len(candidate) > len(current):
        return candidate
    return current


def assign_courses(conversations: list[dict], official_names: list[str]) -> None:
    """Set course_name on each conversation. Missing welcomes stay Unknown Course."""
    official_match: dict[str, str | None] = {}

    def resolve(spoken: str) -> str | None:
        cached = official_match.get(spoken)
        if spoken in official_match:
            return cached
        matched = match_official_name(spoken, official_names)
        official_match[spoken] = matched
        return matched

    spoken_by_phone: dict[str, set[str]] = {}
    for conversation in conversations:
        spoken = spoken_course_name(conversation)
        conversation["spoken_course_name"] = spoken
        phone = re.sub(r"\D", "", conversation.get("vapi_golf_course_phone_no") or "")
        conversation["voice_phone_digits"] = phone
        if spoken and phone:
            spoken_by_phone.setdefault(phone, set()).add(spoken)

    resolved_by_phone: dict[str, str] = {}
    for phone, spoken_names in spoken_by_phone.items():
        resolved = [resolve(name) or name for name in spoken_names]
        chosen = ""
        compatible = True
        for name in resolved:
            if not chosen:
                chosen = name
                continue
            if _same_club(chosen, name):
                chosen = _prefer_name(chosen, name, official_names)
            else:
                compatible = False
                break
        if compatible and chosen:
            resolved_by_phone[phone] = chosen

    for conversation in conversations:
        spoken = conversation.get("spoken_course_name")
        if not spoken:
            conversation["course_name"] = UNKNOWN_COURSE
            continue
        phone_name = resolved_by_phone.get(conversation.get("voice_phone_digits") or "")
        if phone_name and _same_club(phone_name, spoken):
            conversation["course_name"] = phone_name
            continue
        conversation["course_name"] = resolve(spoken) or spoken
