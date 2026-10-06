"""Read-only access to production conversations.

The production database must never be modified. This module opens the session
in read-only mode and refuses any SQL that is not a single SELECT.
"""

from __future__ import annotations

import json
import os
import re
from datetime import date, datetime

import psycopg
from psycopg.rows import dict_row

SELECT_ONLY = re.compile(r"^\s*SELECT\b", re.IGNORECASE | re.DOTALL)
FORBIDDEN = re.compile(
    r"\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE|GRANT|REVOKE|COPY|MERGE)\b",
    re.IGNORECASE,
)


class ReadOnlyViolation(RuntimeError):
    """Raised when a query could change production data."""


def assert_select_only(sql: str) -> None:
    statement = sql.strip().rstrip(";")
    if ";" in statement or not SELECT_ONLY.match(statement) or FORBIDDEN.search(statement):
        raise ReadOnlyViolation(
            "Only a single SELECT query is allowed against the production database."
        )


def connect() -> psycopg.Connection:
    missing = [
        name
        for name in ("PGHOST", "PGPORT", "PGDATABASE", "PGUSER", "PGPASSWORD")
        if not os.environ.get(name)
    ]
    if missing:
        raise RuntimeError(
            "Missing database settings in .env: " + ", ".join(missing)
        )

    connection = psycopg.connect(
        host=os.environ["PGHOST"],
        port=os.environ["PGPORT"],
        dbname=os.environ["PGDATABASE"],
        user=os.environ["PGUSER"],
        password=os.environ["PGPASSWORD"],
        sslmode=os.environ.get("PGSSLMODE", "require"),
        connect_timeout=15,
        options="-c default_transaction_read_only=on",
    )
    with connection.cursor() as cursor:
        cursor.execute("SHOW default_transaction_read_only")
        mode = cursor.fetchone()[0]
    if str(mode).lower() != "on":
        connection.close()
        raise ReadOnlyViolation("PostgreSQL did not enable read-only mode.")
    return connection


def _digits(value: str | None) -> str:
    return re.sub(r"\D", "", value or "")


def _parse_booking_data(value):
    if value is None or value == "":
        return None
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return None
        if isinstance(parsed, str):
            try:
                parsed = json.loads(parsed)
            except json.JSONDecodeError:
                return None
        return parsed if isinstance(parsed, dict) else None
    return None


def fetch_conversations(
    connection: psycopg.Connection,
    *,
    course_phone: str | None = None,
    customer_phone: str | None = None,
    on_date: date | None = None,
    timezone_name: str = "Asia/Kolkata",
) -> list[dict]:
    """Return matching conversations from public.conversations."""
    where = []
    params: list = [timezone_name]

    course_digits = _digits(course_phone)
    if course_digits:
        where.append(
            "regexp_replace(c.vapi_golf_course_phone_no, '\\D', '', 'g') = %s"
        )
        params.append(course_digits)

    customer_digits = _digits(customer_phone)
    if customer_digits:
        where.append("regexp_replace(c.customer_phone_no, '\\D', '', 'g') = %s")
        params.append(customer_digits)

    if on_date is not None:
        # created_at is timestamptz, for example 2026-05-18 11:20:01.912 +0530.
        # Compare only the calendar date in the report timezone.
        where.append(
            "to_char(c.created_at AT TIME ZONE %s, 'YYYY-MM-DD') = %s"
        )
        params.extend([timezone_name, on_date.isoformat()])

    sql = """
        SELECT
            c.id,
            c.call_id,
            c.customer_phone_no,
            c.vapi_golf_course_phone_no,
            c.transcript,
            c.end_call_reason,
            c.created_at,
            to_char(c.created_at AT TIME ZONE %s, 'YYYY-MM-DD') AS created_date,
            c.updated_at,
            c.summary,
            c.hasbooking,
            c.booking_id,
            c.booking_data,
            c.customer_name,
            c.call_length,
            c.call_outcome,
            c.messages,
            b.status AS booking_record_status,
            b.total_players
        FROM public.conversations AS c
        LEFT JOIN public.bookings AS b ON b.id = c.booking_id
    """
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY c.created_at DESC"
    assert_select_only(sql)

    with connection.cursor(row_factory=dict_row) as cursor:
        cursor.execute(sql, params)
        rows = cursor.fetchall()

    conversations = []
    for row in rows:
        created_at = row["created_at"]
        updated_at = row["updated_at"]
        conversations.append(
            {
                "id": row["id"],
                "call_id": row["call_id"],
                "customer_phone_no": row["customer_phone_no"],
                "vapi_golf_course_phone_no": row["vapi_golf_course_phone_no"],
                "transcript": row["transcript"] or "",
                "end_call_reason": row["end_call_reason"],
                "created_at": created_at.isoformat()
                if isinstance(created_at, datetime)
                else created_at,
                "created_date": row["created_date"],
                "updated_at": updated_at.isoformat()
                if isinstance(updated_at, datetime)
                else updated_at,
                "summary": row["summary"],
                "hasbooking": row["hasbooking"],
                "booking_id": row["booking_id"],
                "booking_data": _parse_booking_data(row["booking_data"]),
                "customer_name": row["customer_name"],
                "call_length": row["call_length"],
                "call_outcome": row["call_outcome"],
                "messages": _parse_messages(row["messages"]),
                "booking_record_status": row["booking_record_status"],
                "total_players": row["total_players"] or 0,
            }
        )
    return conversations


def fetch_coursewise_conversations(
    connection: psycopg.Connection,
    *,
    on_date: date,
    customer_phone: str | None = None,
    timezone_name: str = "America/New_York",
) -> list[dict]:
    """One read of the conversations needed for a course-wise day report.

    The day bounds are the same US Eastern calendar day used by the report.
    Only columns used for course naming and transcript analysis are returned.
    """
    where = [
        "c.created_at >= (%s::timestamp AT TIME ZONE %s)",
        "c.created_at < ((%s::timestamp + interval '1 day') AT TIME ZONE %s)",
    ]
    day = on_date.isoformat()
    params: list = [day, timezone_name, day, timezone_name]
    customer_digits = _digits(customer_phone)
    if customer_digits:
        where.append("regexp_replace(c.customer_phone_no, '\\D', '', 'g') = %s")
        params.append(customer_digits)

    sql = """
        SELECT
            c.id,
            c.call_id,
            c.vapi_golf_course_phone_no,
            c.transcript,
            c.end_call_reason,
            c.created_at,
            c.hasbooking,
            c.booking_data,
            c.call_outcome,
            c.messages,
            b.status AS booking_record_status
        FROM public.conversations AS c
        LEFT JOIN public.bookings AS b ON b.id = c.booking_id
        WHERE """ + " AND ".join(where) + """
        ORDER BY c.created_at DESC
    """
    assert_select_only(sql)
    with connection.cursor(row_factory=dict_row) as cursor:
        cursor.execute(sql, params)
        rows = cursor.fetchall()

    conversations = []
    for row in rows:
        created_at = row["created_at"]
        conversations.append(
            {
                "id": row["id"],
                "call_id": row["call_id"],
                "vapi_golf_course_phone_no": row["vapi_golf_course_phone_no"],
                "transcript": row["transcript"] or "",
                "end_call_reason": row["end_call_reason"],
                "created_at": created_at.isoformat()
                if isinstance(created_at, datetime)
                else created_at,
                "hasbooking": row["hasbooking"],
                "booking_data": _parse_booking_data(row["booking_data"]),
                "call_outcome": row["call_outcome"],
                "messages": _parse_messages(row["messages"]),
                "booking_record_status": row["booking_record_status"],
            }
        )
    return conversations


def fetch_golf_course_names(connection: psycopg.Connection) -> list[str]:
    """Return official course names. Used only to normalize a spoken welcome name."""
    sql = """
        SELECT golf_course_name
        FROM public.golf_courses
        WHERE golf_course_name IS NOT NULL
          AND btrim(golf_course_name) <> ''
        ORDER BY length(golf_course_name) DESC, golf_course_name
    """
    assert_select_only(sql)
    with connection.cursor() as cursor:
        cursor.execute(sql)
        return [row[0] for row in cursor.fetchall()]


def _parse_messages(value):
    if value is None or value == "":
        return []
    if isinstance(value, list):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return []
        return parsed if isinstance(parsed, list) else []
    return []


def _conversation_record(row: dict) -> dict:
    created_at = row["created_at"]
    updated_at = row["updated_at"]
    return {
        "id": row["id"],
        "call_id": row["call_id"],
        "customer_phone_no": row["customer_phone_no"],
        "vapi_golf_course_phone_no": row["vapi_golf_course_phone_no"],
        "transcript": row["transcript"] or "",
        "end_call_reason": row["end_call_reason"],
        "created_at": created_at.isoformat() if isinstance(created_at, datetime) else created_at,
        "created_date": row["created_date"],
        "updated_at": updated_at.isoformat() if isinstance(updated_at, datetime) else updated_at,
        "summary": row["summary"],
        "hasbooking": row["hasbooking"],
        "booking_id": row["booking_id"],
        "booking_data": _parse_booking_data(row["booking_data"]),
        "customer_name": row["customer_name"],
        "call_length": row["call_length"],
        "call_outcome": row["call_outcome"],
        "booking_record_status": row["booking_record_status"],
        "total_players": row["total_players"] or 0,
        "course_id": row["course_id"],
        "golf_course_name": row["golf_course_name"],
    }


def fetch_target_course_conversations(
    connection: psycopg.Connection,
    course_ids: list[int],
) -> dict:
    """Yesterday's US Eastern calls for the given golf course ids.

    A voice number is used only when it points at exactly one of those courses.
    Numbers that point at more than one course are returned separately and are
    not attached to a conversation.
    """
    sql = """
        SELECT
            mapped.kind,
            mapped.id,
            mapped.call_id,
            mapped.customer_phone_no,
            mapped.vapi_golf_course_phone_no,
            mapped.transcript,
            mapped.end_call_reason,
            mapped.created_at,
            mapped.created_date,
            mapped.updated_at,
            mapped.summary,
            mapped.hasbooking,
            mapped.booking_id,
            mapped.booking_data,
            mapped.customer_name,
            mapped.call_length,
            mapped.call_outcome,
            mapped.booking_record_status,
            mapped.total_players,
            mapped.course_id,
            mapped.golf_course_name,
            mapped.ambiguous_phone,
            mapped.ambiguous_course_ids,
            mapped.report_date
        FROM (
            WITH bounds AS (
                SELECT
                    (((now() AT TIME ZONE 'America/New_York')::date - 1)::timestamp
                        AT TIME ZONE 'America/New_York') AS start_at,
                    ((now() AT TIME ZONE 'America/New_York')::date::timestamp
                        AT TIME ZONE 'America/New_York') AS end_at,
                    to_char(
                        (now() AT TIME ZONE 'America/New_York')::date - 1,
                        'YYYY-MM-DD'
                    ) AS report_date
            ),
            links AS (
                SELECT
                    regexp_replace(vn.phone_number, '\\D', '', 'g') AS phone_digits,
                    vcc.golf_course_id
                FROM public.voice_numbers AS vn
                JOIN public.voice_channel_configurations AS vcc
                  ON vcc.id = vn.voice_channel_config_id
                WHERE vcc.golf_course_id = ANY(%s)
                  AND regexp_replace(vn.phone_number, '\\D', '', 'g') <> ''
            ),
            phone_course AS (
                SELECT phone_digits, MIN(golf_course_id) AS golf_course_id
                FROM links
                GROUP BY phone_digits
                HAVING COUNT(DISTINCT golf_course_id) = 1
            )
            SELECT
                'conversation'::text AS kind,
                c.id,
                c.call_id,
                c.customer_phone_no,
                c.vapi_golf_course_phone_no,
                c.transcript,
                c.end_call_reason,
                c.created_at,
                to_char(c.created_at AT TIME ZONE 'America/New_York', 'YYYY-MM-DD') AS created_date,
                c.updated_at,
                c.summary,
                c.hasbooking,
                c.booking_id,
                c.booking_data,
                c.customer_name,
                c.call_length,
                c.call_outcome,
                b.status AS booking_record_status,
                b.total_players,
                pc.golf_course_id AS course_id,
                g.golf_course_name,
                NULL::text AS ambiguous_phone,
                NULL::bigint[] AS ambiguous_course_ids,
                bounds.report_date
            FROM bounds
            JOIN public.conversations AS c
              ON c.created_at >= bounds.start_at
             AND c.created_at < bounds.end_at
            JOIN phone_course AS pc
              ON pc.phone_digits = regexp_replace(c.vapi_golf_course_phone_no, '\\D', '', 'g')
            JOIN public.golf_courses AS g ON g.id = pc.golf_course_id
            LEFT JOIN public.bookings AS b ON b.id = c.booking_id
            UNION ALL
            SELECT
                'ambiguous'::text,
                NULL,
                NULL,
                NULL,
                NULL,
                NULL,
                NULL,
                NULL,
                NULL,
                NULL,
                NULL,
                NULL,
                NULL,
                NULL,
                NULL,
                NULL,
                NULL,
                NULL,
                NULL,
                NULL,
                NULL,
                links.phone_digits,
                array_agg(DISTINCT links.golf_course_id ORDER BY links.golf_course_id),
                bounds.report_date
            FROM links
            CROSS JOIN bounds
            GROUP BY links.phone_digits, bounds.report_date
            HAVING COUNT(DISTINCT links.golf_course_id) > 1
            UNION ALL
            SELECT
                'meta'::text,
                NULL,
                NULL,
                NULL,
                NULL,
                NULL,
                NULL,
                NULL,
                NULL,
                NULL,
                NULL,
                NULL,
                NULL,
                NULL,
                NULL,
                NULL,
                NULL,
                NULL,
                NULL,
                NULL,
                NULL,
                NULL,
                NULL,
                bounds.report_date
            FROM bounds
        ) AS mapped
    """
    assert_select_only(sql)
    with connection.cursor(row_factory=dict_row) as cursor:
        cursor.execute(sql, (course_ids,))
        rows = cursor.fetchall()

    report_date = ""
    conversations = []
    ambiguous_phones = []
    for row in rows:
        if row["report_date"]:
            report_date = row["report_date"]
        if row["kind"] == "conversation":
            conversations.append(_conversation_record(row))
        elif row["kind"] == "ambiguous":
            ambiguous_phones.append(
                {
                    "phone_digits": row["ambiguous_phone"],
                    "course_ids": list(row["ambiguous_course_ids"] or []),
                }
            )
    conversations.sort(key=lambda item: item["created_at"] or "", reverse=True)
    return {
        "report_date": report_date,
        "conversations": conversations,
        "ambiguous_phones": ambiguous_phones,
    }


def fetch_ten_course_counts(
    connection: psycopg.Connection,
    courses: list[dict],
    on_date: date,
) -> dict:
    """Count one US Eastern day of calls for the 10 fetch courses.

    Highland Creek is matched by its known voice line. The other courses are
    matched through voice_numbers. A phone is kept only when it points at
    exactly one of these courses. If voice_numbers cannot be read, only
    Highland Creek is counted and the rest are marked not fetched.
    """
    voice_course = next(course for course in courses if course.get("voice_line"))
    course_ids = [int(course["id"]) for course in courses]
    other_ids = [course_id for course_id in course_ids if course_id != voice_course["id"]]
    try:
        counts = _count_courses_by_voice_numbers(
            connection,
            voice_line=_digits(voice_course["voice_line"]),
            voice_course_id=int(voice_course["id"]),
            course_ids=course_ids,
            on_date=on_date,
        )
    except psycopg.errors.InsufficientPrivilege:
        connection.rollback()
        counts = {
            int(voice_course["id"]): _count_conversations_for_phone(
                connection,
                _digits(voice_course["voice_line"]),
                on_date,
            )
        }
        return {
            "report_date": on_date.isoformat(),
            "counts": counts,
            "not_fetched": other_ids,
        }
    return {
        "report_date": on_date.isoformat(),
        "counts": counts,
        "not_fetched": [],
    }


def _count_courses_by_voice_numbers(
    connection: psycopg.Connection,
    *,
    voice_line: str,
    voice_course_id: int,
    course_ids: list[int],
    on_date: date,
) -> dict[int, int]:
    sql = """
        SELECT mapped.golf_course_id, mapped.conversation_count
        FROM (
            WITH links AS (
                SELECT %s AS phone_digits, %s::bigint AS golf_course_id
                UNION ALL
                SELECT
                    regexp_replace(vn.phone_number, '\\D', '', 'g') AS phone_digits,
                    vcc.golf_course_id
                FROM public.voice_numbers AS vn
                JOIN public.voice_channel_configurations AS vcc
                  ON vcc.id = vn.voice_channel_config_id
                WHERE vcc.golf_course_id = ANY(%s)
                  AND regexp_replace(vn.phone_number, '\\D', '', 'g') <> ''
            ),
            phone_course AS (
                SELECT phone_digits, MIN(golf_course_id) AS golf_course_id
                FROM links
                GROUP BY phone_digits
                HAVING COUNT(DISTINCT golf_course_id) = 1
            )
            SELECT
                pc.golf_course_id,
                COUNT(c.id) AS conversation_count
            FROM phone_course AS pc
            JOIN public.conversations AS c
              ON regexp_replace(c.vapi_golf_course_phone_no, '\\D', '', 'g') = pc.phone_digits
             AND to_char(c.created_at AT TIME ZONE 'America/New_York', 'YYYY-MM-DD') = %s
            GROUP BY pc.golf_course_id
        ) AS mapped
    """
    assert_select_only(sql)
    with connection.cursor(row_factory=dict_row) as cursor:
        cursor.execute(sql, (voice_line, voice_course_id, course_ids, on_date.isoformat()))
        rows = cursor.fetchall()
    return {int(row["golf_course_id"]): int(row["conversation_count"]) for row in rows}


def _count_conversations_for_phone(
    connection: psycopg.Connection,
    voice_line: str,
    on_date: date,
) -> int:
    sql = """
        SELECT COUNT(*) AS conversation_count
        FROM public.conversations AS c
        WHERE regexp_replace(c.vapi_golf_course_phone_no, '\\D', '', 'g') = %s
          AND to_char(c.created_at AT TIME ZONE 'America/New_York', 'YYYY-MM-DD') = %s
    """
    assert_select_only(sql)
    with connection.cursor(row_factory=dict_row) as cursor:
        cursor.execute(sql, (voice_line, on_date.isoformat()))
        row = cursor.fetchone()
    return int(row["conversation_count"])
