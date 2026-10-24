"""Assign each call to SCO, MCO, or V1.

A conversation Golf Course ID is SCO. An Organization ID is MCO only when
that Golf Course ID is missing. A call with neither ID stays a V1 candidate.
The voice configuration, phone number, or welcome message can then identify
it. A match to one golf course is SCO, and a match to one organization is
MCO. Unknown Course is used only when that fallback names nothing.
SCO calls that share a Golf Course ID use the most common course name.
"""

from __future__ import annotations

import re
from collections import Counter

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


def _clean(value) -> str:
    return " ".join(str(value or "").split())


def _key(value: str) -> str:
    key = re.sub(r"[^a-z0-9]+", " ", value.lower()).strip()
    if key.startswith("the "):
        key = key[4:]
    return key


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


def _spoken_forms(spoken: str) -> list[str]:
    """Welcome text, plus the same name with & written as 'and'."""
    display = " ".join(spoken.split())
    expanded = " ".join(spoken.replace("&", " and ").split())
    if expanded == display:
        return [display]
    return [display, expanded]


def _spoken_key(spoken: str) -> str:
    """Group welcome variants that name the same course."""
    return _key(spoken.replace("&", " and "))


def v1_names_for(conversations: list[dict], official_names: list[str]) -> dict[int, str]:
    """Name each V1 call from its welcome message.

    An official name is used when the welcome matches one. Otherwise the
    course name spoken in the welcome is kept. Unknown Course is used only
    when the welcome does not name a course.
    """
    pending = []
    for index, conversation in enumerate(conversations):
        if conversation.get("golf_course_id") is not None or conversation.get("organization_id") is not None:
            continue
        spoken = spoken_course_name(conversation)
        if not spoken:
            pending.append((index, "", []))
            continue
        pending.append((index, _spoken_key(spoken), _spoken_forms(spoken)))

    chosen: dict[str, str] = {}
    for _, key, forms in pending:
        if not key:
            continue
        official = None
        for form in forms:
            official = match_official_name(form, official_names)
            if official:
                break
        if official:
            chosen[key] = official
            continue
        display = forms[0]
        current = chosen.get(key)
        if current is None or len(display) > len(current):
            chosen[key] = display

    return {
        index: chosen.get(key, UNKNOWN_COURSE) if key else UNKNOWN_COURSE
        for index, key, _forms in pending
    }


def _count(conversation: dict, key: str) -> int:
    value = conversation.get(key)
    return int(value or 0)


def _voice_course(conversation: dict) -> tuple[str, str] | None:
    """SCO or MCO when every matched voice configuration identifies one course."""
    if _count(conversation, "voice_blank_config_count"):
        return None
    golf_ids = _count(conversation, "voice_golf_id_count")
    golf_configs = _count(conversation, "voice_golf_config_count")
    org_ids = _count(conversation, "voice_org_only_id_count")
    org_configs = _count(conversation, "voice_org_only_config_count")
    if golf_configs and org_configs:
        return None
    if golf_ids == 1 and golf_configs >= 1:
        name = _clean(conversation.get("voice_config_course_name")) or _clean(
            conversation.get("voice_golf_course_name")
        )
        if name:
            return ("SCO", name)
        return None
    if golf_ids == 0 and org_ids == 1 and org_configs >= 1:
        name = _clean(conversation.get("voice_config_org_name")) or _clean(
            conversation.get("voice_organization_name")
        )
        if name:
            return ("MCO", name)
    return None


def _official_course(name: str, golf_names: list[str], organization_names: list[str]) -> tuple[str, str] | None:
    """SCO when the name is one golf course. MCO when it is one organization."""
    golf_name = match_official_name(name, golf_names)
    if golf_name:
        return ("SCO", golf_name)
    organization_name = match_official_name(name, organization_names)
    if organization_name:
        return ("MCO", organization_name)
    return None


def assign_courses(
    conversations: list[dict],
    official_names: list[str] | None = None,
    golf_names: list[str] | None = None,
    organization_names: list[str] | None = None,
) -> None:
    """Set one course name and one list on each conversation.

    Conversation IDs decide SCO and MCO first. Voice configuration and the
    welcome message are used only for calls that have neither ID. A fallback
    name that belongs to one golf course or organization leaves the V1 list.
    """
    names = list(official_names or [])
    golf = list(golf_names or [])
    organizations = list(organization_names or [])
    v1_names = v1_names_for(conversations, names)
    for index, conversation in enumerate(conversations):
        if conversation.get("golf_course_id") is not None:
            conversation["course_kind"] = "SCO"
            conversation["course_name"] = _clean(conversation.get("golf_course_name")) or UNKNOWN_COURSE
            continue
        if conversation.get("organization_id") is not None:
            conversation["course_kind"] = "MCO"
            conversation["course_name"] = _clean(conversation.get("organization_name")) or UNKNOWN_COURSE
            continue
        voice_course = _voice_course(conversation)
        if voice_course is not None:
            conversation["course_kind"], conversation["course_name"] = voice_course
            continue
        identified = _official_course(v1_names[index], golf, organizations)
        if identified is not None:
            conversation["course_kind"], conversation["course_name"] = identified
            continue
        conversation["course_kind"] = "V1"
        conversation["course_name"] = v1_names[index]
    _unify_sco_names(conversations)


def _sco_golf_id(conversation: dict):
    """Golf Course ID for an SCO call. Conversation ID wins over the voice configuration."""
    if conversation.get("course_kind") != "SCO":
        return None
    if conversation.get("golf_course_id") is not None:
        return conversation.get("golf_course_id")
    if conversation.get("voice_golf_course_id") is not None and _count(conversation, "voice_golf_id_count") == 1:
        return conversation.get("voice_golf_course_id")
    return None


def _most_common_name(names: list[str]) -> str:
    """Most common non-empty name. A tie uses the longer name."""
    valid = [name for name in names if name and name != UNKNOWN_COURSE]
    if not valid:
        return ""
    counts = Counter(valid)
    return sorted(counts, key=lambda name: (-counts[name], -len(name), name.lower()))[0]


def _unify_sco_names(conversations: list[dict]) -> None:
    """One display name per Golf Course ID. Different IDs stay separate."""
    groups: dict = {}
    for conversation in conversations:
        golf_id = _sco_golf_id(conversation)
        if golf_id is None:
            continue
        groups.setdefault(golf_id, []).append(conversation)
    for grouped in groups.values():
        chosen = _most_common_name([_clean(item.get("course_name")) for item in grouped])
        if not chosen:
            continue
        for conversation in grouped:
            conversation["course_name"] = chosen
