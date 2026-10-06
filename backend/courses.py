"""Courses included in this analysis. Production data is not modified."""

# The database stores this course as "The Ranch Course".
# The requested label was "The Ranch Course - Genoa".
TARGET_COURSES = (
    {"id": 91, "name": "Airport Golf Club"},
    {"id": 85, "name": "Apple Mountain Golf Club"},
    {"id": 108, "name": "Caradoc Sands Golf Club"},
    {"id": 16, "name": "Desert Gold"},
    {"id": 161, "name": "Fire Ridge Golf Club"},
    {"id": 135, "name": "Foxfire Golf at Par 4 Resort"},
    {"id": 121, "name": "Gold Course"},
    {"id": 117, "name": "Green Valley Golf Course"},
    {"id": 148, "name": "Hales Mills Country Club"},
    {"id": 138, "name": "Hidden Valley Golf Course"},
    {"id": 1, "name": "Highland Creek Golf Club"},
    {"id": 26, "name": "Highlands Reserve Golf Club"},
    {"id": 145, "name": "Indian Springs Montana"},
    {"id": 25, "name": "Izatys Golf Resort"},
    {"id": 12, "name": "Jeffersonville Golf Club"},
    {"id": 142, "name": "Lee Park Golf Course"},
    {"id": 63, "name": "Legacy Golf Club"},
    {"id": 24, "name": "Lida Greens Golf Course"},
    {"id": 44, "name": "Long Marsh Course"},
    {"id": 65, "name": "Miami Lakes Golf Club"},
    {"id": 76, "name": "Moorpark Country Club"},
    {"id": 157, "name": "Salishan Golf Links"},
    {"id": 128, "name": "The Course at Pillow Springs"},
    {"id": 50, "name": "The Divide Golf Club"},
    {"id": 159, "name": "The Ranch Course"},
)

SELECTED_COURSE_NAMES = tuple(course["name"] for course in TARGET_COURSES)

# Highland Creek uses the known voice line. The other nine are matched through
# voice_numbers when that table can be read.
FETCH_COURSES = (
    {"id": 1, "name": "Highland Creek Golf Club", "voice_line": "17044862984"},
    {"id": 91, "name": "Airport Golf Club"},
    {"id": 85, "name": "Apple Mountain Golf Club"},
    {"id": 108, "name": "Caradoc Sands Golf Club"},
    {"id": 16, "name": "Desert Gold"},
    {"id": 161, "name": "Fire Ridge Golf Club"},
    {"id": 135, "name": "Foxfire Golf at Par 4 Resort"},
    {"id": 121, "name": "Gold Course"},
    {"id": 117, "name": "Green Valley Golf Course"},
    {"id": 148, "name": "Hales Mills Country Club"},
)
