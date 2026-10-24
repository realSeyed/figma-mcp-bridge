"""The shared command-line behaviour of the scripts.

Exit codes: 0 when the run is complete and each check passes, 1 when a check
fails, 2 when an input is missing or refused. An input error prints one line
to standard error and writes no further output.
"""

from __future__ import annotations

import sys

from .config import ConfigError
from .dumps import DumpError
from .manifest import ManifestError
from .outputs import OutputError

EXIT_OK = 0
EXIT_FAILED = 1
EXIT_INPUT = 2


class InputError(Exception):
    """An input of a script holds a value that the script cannot use."""


INPUT_ERRORS = (ConfigError, DumpError, InputError, ManifestError, OutputError)


def run(main) -> None:
    """Runs a `main` that returns an exit code, and turns each input error into exit code 2."""
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    try:
        code = main()
    except INPUT_ERRORS as err:
        print(f'error: {err}', file=sys.stderr)
        code = EXIT_INPUT
    sys.exit(EXIT_OK if code is None else code)


def add_dump_options(parser) -> None:
    """The options that pick one root of a dump."""
    parser.add_argument('--root', default=None, help='The root to read from a dump folder of more than one root.')
    parser.add_argument(
        '--format',
        choices=['baseline', 'dump_nodes'],
        default=None,
        help='Force the format. Only needed for a baseline file in an older read form that keeps hidden nodes.',
    )


def add_outputs_option(parser) -> None:
    parser.add_argument(
        '--outputs',
        required=True,
        help='The outputs folder. It may not lie in an evidence folder or in the fixtures folder.',
    )
    parser.add_argument(
        '--fixtures',
        default=None,
        help='The fixtures folder, which no output may enter. A folder that holds expected.json is refused anyway.',
    )
