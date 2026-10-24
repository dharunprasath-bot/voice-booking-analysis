"""Assign each call from the IDs stored on the conversation.

A Golf Course ID is SCO even when an Organization ID is also present. An
Organization ID is MCO only when the Golf Course ID is missing. A call with
neither stays unclassified. Names come from golf_courses and organizations.
Phone numbers, welcome text, and transcripts are not used.
"""

from __future__ import annotations

UNKNOWN_COURSE = "Unknown Course"


def _clean(value) -> str:
    return " ".join(str(value or "").split())


def assign_courses(
    conversations: list[dict],
    official_names: list[str] | None = None,
    golf_names: list[str] | None = None,
    organization_names: list[str] | None = None,
) -> None:
    """Set course_kind, course_id, and course_name from the conversation IDs."""
    del official_names, golf_names, organization_names
    for conversation in conversations:
        golf_id = conversation.get("golf_course_id")
        org_id = conversation.get("organization_id")
        conversation["course_conflict"] = False
        if golf_id is not None:
            conversation["course_kind"] = "SCO"
            conversation["course_id"] = golf_id
            conversation["course_name"] = _clean(conversation.get("golf_course_name")) or f"Golf Course {golf_id}"
        elif org_id is not None:
            conversation["course_kind"] = "MCO"
            conversation["course_id"] = org_id
            conversation["course_name"] = _clean(conversation.get("organization_name")) or f"Organization {org_id}"
        else:
            conversation["course_kind"] = ""
            conversation["course_id"] = None
            conversation["course_name"] = ""
