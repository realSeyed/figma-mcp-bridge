"""Field paths into a node, and the comparison of two parsed values.

A path is a dotted list of keys with list indexes: `styles.fills[0].color`.
A key that holds a dot or a bracket is written as `["the key"]`:
`componentProperties["Label#1:2"].value`. `assert.py` reads a field with it,
and `diff_dumps.py` reports each changed field with it.
"""

from __future__ import annotations

import json
import re

_KEY = re.compile(r'[^.\[\]"]+')
_INDEX = re.compile(r'\[(\d+)\]')
_QUOTED = re.compile(r'\[("(?:[^"\\]|\\.)*")\]')

ABSENT = object()
"""The result of a path that leads to no value."""


class PathError(Exception):
    """A path is not written in the form above."""


def parse_path(text: str) -> list:
    """The steps of a path: a string for a key, an int for a list index."""
    if not isinstance(text, str) or text == '':
        raise PathError('the path is empty.')
    steps: list = []
    pos = 0
    expect_key = True
    while pos < len(text):
        if text[pos] == '.':
            if expect_key:
                raise PathError(f'{text!r}: a dot at {pos} has no key before it.')
            pos += 1
            expect_key = True
            continue
        if text[pos] == '[':
            match = _INDEX.match(text, pos)
            if match is not None:
                steps.append(int(match.group(1)))
            else:
                match = _QUOTED.match(text, pos)
                if match is None:
                    raise PathError(f'{text!r}: the bracket at {pos} is neither [n] nor ["key"].')
                try:
                    steps.append(json.loads(match.group(1)))
                except json.JSONDecodeError:
                    raise PathError(f'{text!r}: the quoted key at {pos} is not a JSON string.') from None
            pos = match.end()
            expect_key = False
            continue
        if not expect_key:
            raise PathError(f'{text!r}: expected a dot or a bracket at {pos}.')
        match = _KEY.match(text, pos)
        if match is None:
            raise PathError(f'{text!r}: a quote at {pos} must sit in ["key"].')
        steps.append(match.group())
        pos = match.end()
        expect_key = False
    if expect_key:
        raise PathError(f'{text!r}: the path ends with a dot.')
    return steps


def format_path(steps) -> str:
    """The text of a list of steps; the inverse of `parse_path`."""
    out = ''
    for step in steps:
        if isinstance(step, int):
            out += f'[{step}]'
        elif _KEY.fullmatch(step):
            out += ('.' if out else '') + step
        else:
            out += f'[{json.dumps(step, ensure_ascii=False)}]'
    return out


def resolve(value, steps):
    """The value at a path, or `ABSENT` when a step leads nowhere."""
    for step in steps:
        if isinstance(step, int):
            if not isinstance(value, list) or step >= len(value):
                return ABSENT
            value = value[step]
        else:
            if not isinstance(value, dict) or step not in value:
                return ABSENT
            value = value[step]
    return value


def values_equal(a, b) -> bool:
    """Equality of parsed JSON values: 1 equals 1.0, but true does not equal 1."""
    if isinstance(a, bool) or isinstance(b, bool):
        return isinstance(a, bool) and isinstance(b, bool) and a == b
    if isinstance(a, dict) and isinstance(b, dict):
        return a.keys() == b.keys() and all(values_equal(a[key], b[key]) for key in a)
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(values_equal(x, y) for x, y in zip(a, b))
    if isinstance(a, (dict, list)) or isinstance(b, (dict, list)):
        return False
    return a == b


def changed_paths(a, b, steps=()) -> list[str]:
    """The paths at which two parsed values differ.

    Objects are compared key by key, lists index by index. A key or an index
    that only one side holds is reported at its own path. Key order and
    whitespace play no part: the values are parsed.
    """
    if isinstance(a, dict) and isinstance(b, dict):
        found = []
        for key in sorted(a.keys() | b.keys()):
            below = (*steps, key)
            if key not in a or key not in b:
                found.append(format_path(below))
            else:
                found += changed_paths(a[key], b[key], below)
        return found
    if isinstance(a, list) and isinstance(b, list):
        found = []
        for index in range(max(len(a), len(b))):
            below = (*steps, index)
            if index >= len(a) or index >= len(b):
                found.append(format_path(below))
            else:
                found += changed_paths(a[index], b[index], below)
        return found
    if values_equal(a, b):
        return []
    return [format_path(steps)]
