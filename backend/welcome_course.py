"""Assign each call to one course from the conversation row's own ids.

Golf Course ID names a direct SCO course. Organization ID names an MCO
organization. A call is stored under exactly one of those names.
"""

from __future__ import annotations

UNKNOWN_COURSE = "Unknown Course"


def _clean(value) -> str:
    return " ".join(str(value or "").split())


def course_name_for(conversation: dict) -> str:
    """Return the single category name for this conversation.

    An organization-level call stays under the organization even when the row
    also has a golf course id. A golf-course-level call stays under that course.
    """
    level = _clean(conversation.get("config_level")).lower()
    course_id = conversation.get("golf_course_id")
    org_id = conversation.get("organization_id")
    course_name = _clean(conversation.get("golf_course_name"))
    org_name = _clean(conversation.get("organization_name"))

    if level == "organization" or (org_id is not None and level != "golf_course"):
        return org_name or UNKNOWN_COURSE
    if level == "golf_course" or course_id is not None:
        return course_name or UNKNOWN_COURSE
    return UNKNOWN_COURSE


def assign_courses(conversations: list[dict]) -> None:
    """Set course_name on each conversation. Each call receives one name."""
    for conversation in conversations:
        conversation["course_name"] = course_name_for(conversation)
