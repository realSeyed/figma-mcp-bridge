import json

from . import helpers
from .helpers import TempDirTestCase
from .package_helpers import CAPTURE_NAME, CHECKS, DEFECTS, ERRORS, IDENTITY, SURFACES, build_package, make_git_repo

import render_report
from auditlib.manifest import sha256_file
from auditlib.toolset import toolset_commit


class ReportTest(TempDirTestCase):
    """Each test renders from a real `assert.py` output on the synthetic package."""

    def setUp(self):
        super().setUp()
        self.package = build_package(self.tmp)
        self.outputs = self.tmp / 'out'
        self.assert_dir = self.tmp / 'assert'
        self.run_assert()
        self.surfaces = self.package / 'inputs' / 'surfaces.json'
        self.errors = self.package / 'inputs' / 'prescription-errors.json'
        self.defects = self.package / 'inputs' / 'defects.json'
        # The tiles of the surface declaration come from tile.py, as in a real audit.
        self.tile_dir = self.tmp / 'tiles'
        done = helpers.run_script(
            'tile.py',
            self.package / 'captures' / 'frame.png',
            '--manifest',
            self.package / 'captures' / CAPTURE_NAME,
            '--tile-size', '100', '--overlap', '20', '--label', 'tiles',
            '--outputs', self.tile_dir,
        )
        self.assertEqual(done.returncode, 0, done.stderr)

    def run_assert(self, checks=None):
        checks_file = self.package / 'checks.json'
        if checks is not None:
            helpers.write_json(checks_file, checks)
        done = helpers.run_script(
            'assert.py', checks_file, self.package / 'dumps' / 'run1', '--label', 'acceptance', '--outputs', self.assert_dir
        )
        self.assertIn(done.returncode, (0, 1), done.stderr)
        return self.assert_dir / 'acceptance.assert.json'

    def render(self, *extra, assert_json=None, surfaces=None, errors=None, defects=None):
        return helpers.run_script(
            'render_report.py',
            '--assert', assert_json or self.assert_dir / 'acceptance.assert.json',
            '--surfaces', surfaces or self.surfaces,
            '--prescription-errors', errors or self.errors,
            '--defects', defects or self.defects,
            '--manifest',
            self.package / 'dumps' / 'run1' / 'manifest.json',
            self.package / 'captures' / CAPTURE_NAME,
            '--tiles', self.tile_dir / 'tiles.tiles.json',
            '--outputs', self.outputs,
            *extra,
        )

    def report(self):
        return (self.outputs / 'report.md').read_text(encoding='utf-8')

    def test_each_section_is_there_with_figures_from_the_outputs(self):
        done = self.render()
        self.assertEqual(done.returncode, 0, done.stderr)
        text = self.report()
        for heading in ('## Acceptance', '## Surfaces', '## Prescription errors', '## Carried defects', '## Anchors', '## Verdict'):
            self.assertIn(heading, text)
        # The acceptance table: one row for each check of the checks file.
        self.assertIn('| C-1 | N1 | variantCount | eq | 2 | 2 | PASS |', text)
        self.assertIn('| C-3 | N9 | type | eq | "FRAME" | "FRAME" | PASS |', text)
        self.assertIn('3 checks, 3 passed, 0 failed.', text)
        self.assertIn(f'`{sha256_file(self.package / "checks.json")}`', text)
        # The surface declaration, with the counts worked out.
        self.assertIn('### synthetic screen — default', text)
        self.assertIn('Captures: 1:', text)
        self.assertIn('Tiles: 2:', text)
        # The two lists.
        self.assertIn('| PE-1 |  | closed | A synthetic prescription error. |', text)
        self.assertIn('| D-1 |  | audit 0 | A synthetic carried defect. |', text)

    def test_the_anchors_come_from_the_manifests_and_git(self):
        self.assertEqual(self.render().returncode, 0)
        text = self.report()
        self.assertIn(f'Toolset commit: `{toolset_commit()}`', text)
        for manifest in (self.package / 'dumps' / 'run1' / 'manifest.json', self.package / 'captures' / CAPTURE_NAME):
            self.assertIn(sha256_file(manifest), text)
        for value in (IDENTITY['bridgeCommit'], IDENTITY['pluginBuild'], IDENTITY['leaderStartedAt']):
            self.assertIn(value, text)
        self.assertIn('| 3 |', text)  # the epoch
        # Each file of the dump manifest is listed with its SHA-256.
        manifest = json.loads((self.package / 'dumps' / 'run1' / 'manifest.json').read_text(encoding='utf-8'))
        for entry in manifest['files']:
            self.assertIn(entry['sha256'], text)
        self.assertIn('None declared.', text)

    def test_seeds_are_listed(self):
        seeds = helpers.write_json(self.tmp / 'seeds.json', {'tile': 7})
        self.assertEqual(self.render('--seeds', seeds).returncode, 0)
        self.assertIn('| tile | 7 |', self.report())
        bad = helpers.write_json(self.tmp / 'bad-seeds.json', {'nothing': 1, 'tile': -1})
        done = self.render('--seeds', bad)
        self.assertEqual(done.returncode, 2)
        self.assertIn('seeds["nothing"]', done.stderr)
        self.assertIn('seeds["tile"]', done.stderr)

    def test_the_same_inputs_give_the_same_report(self):
        self.assertEqual(self.render().returncode, 0)
        first = self.report()
        self.assertEqual(self.render().returncode, 0)
        self.assertEqual(self.report(), first)

    # ── The verdict rule, in both directions ──

    def test_pass_when_each_check_passes_and_no_error_is_open(self):
        done = self.render()
        self.assertEqual(done.returncode, 0)
        self.assertIn('VERDICT PASS', done.stdout)
        self.assertIn('Verdict: **PASS**', self.report())

    def test_a_failed_check_makes_the_verdict_fail(self):
        failing = [*CHECKS, {'id': 'C-4', 'node': 'N9', 'field': 'type', 'op': 'eq', 'expected': 'GROUP'}]
        assert_json = self.run_assert(failing)
        done = self.render(assert_json=assert_json)
        self.assertEqual(done.returncode, 1, done.stderr)
        text = self.report()
        self.assertIn('Verdict: **FAIL**', text)
        self.assertIn('1 of 4 acceptance checks failed', text)
        self.assertIn('| C-4 | N9 | type | eq | "GROUP" | "FRAME" | FAIL |', text)

    def test_an_open_prescription_error_makes_the_verdict_fail(self):
        errors = helpers.write_json(
            self.tmp / 'errors.json',
            [*ERRORS, {'id': 'PE-2', 'frame': 'synthetic screen', 'text': 'Still open.', 'status': 'open'}],
        )
        done = self.render(errors=errors)
        self.assertEqual(done.returncode, 1)
        self.assertIn('1 prescription errors are open: PE-2', self.report())

    def test_a_closed_error_and_a_carried_defect_do_not_change_the_verdict(self):
        defects = helpers.write_json(self.tmp / 'defects.json', [*DEFECTS, {'id': 'D-2', 'text': 'Another one.'}])
        self.assertEqual(self.render(defects=defects).returncode, 0)

    def test_empty_lists_say_so(self):
        empty = helpers.write_json(self.tmp / 'empty.json', [])
        self.assertEqual(self.render(errors=empty, defects=empty).returncode, 0)
        text = self.report()
        self.assertIn('None. The input file lists no prescription error.', text)
        self.assertIn('None. The input file lists no carried defect.', text)

    # ── Inputs that are missing or wrong: no report, no invented figure ──

    def test_a_missing_assert_output_fails_and_writes_no_report(self):
        done = self.render(assert_json=self.tmp / 'nowhere.assert.json')
        self.assertEqual(done.returncode, 2)
        self.assertIn('the input is missing', done.stderr)
        self.assertFalse((self.outputs / 'report.md').exists())

    def test_each_missing_input_file_fails(self):
        for name in ('surfaces', 'errors', 'defects'):
            with self.subTest(name=name):
                done = self.render(**{name: self.tmp / 'nowhere.json'})
                self.assertEqual(done.returncode, 2)
                self.assertFalse((self.outputs / 'report.md').exists())

    def test_an_assert_output_with_edited_rows_is_refused(self):
        path = self.assert_dir / 'acceptance.assert.json'
        data = json.loads(path.read_text(encoding='utf-8'))
        data['results'][0]['result'] = 'FAIL'
        helpers.write_json(path, data)
        done = self.render()
        self.assertEqual(done.returncode, 2)
        self.assertIn('does not match its rows', done.stderr)

    def test_a_manifest_whose_file_changed_is_refused(self):
        with open(self.package / 'dumps' / 'run1' / 'N9.json', 'ab') as f:
            f.write(b' ')
        done = self.render()
        self.assertEqual(done.returncode, 2)
        self.assertIn('manifest', done.stderr)
        self.assertFalse((self.outputs / 'report.md').exists())

    def test_a_manifest_without_the_identity_is_refused(self):
        path = self.package / 'captures' / CAPTURE_NAME
        manifest = json.loads(path.read_text(encoding='utf-8'))
        del manifest['pluginBuild']
        helpers.write_json(path, manifest)
        done = self.render()
        self.assertEqual(done.returncode, 2)
        self.assertIn('pluginBuild', done.stderr)

    def test_a_declared_capture_or_tile_that_no_manifest_lists_is_refused(self):
        surfaces = helpers.write_json(
            self.tmp / 'surfaces.json',
            [{**SURFACES[0], 'captures': ['captures/other.png'], 'tiles': ['tiles.r09c09.png']}],
        )
        done = self.render(surfaces=surfaces)
        self.assertEqual(done.returncode, 2)
        self.assertIn('surfaces[0].captures: "captures/other.png"', done.stderr)
        self.assertIn('surfaces[0].tiles: "tiles.r09c09.png"', done.stderr)

    def test_every_bad_row_is_listed(self):
        surfaces = helpers.write_json(
            self.tmp / 'surfaces.json',
            [{'frame': '', 'surface': 'x', 'read': [], 'captures': 'no', 'extra': 1}, 'text'],
        )
        done = self.render(surfaces=surfaces)
        self.assertEqual(done.returncode, 2)
        for fragment in ('surfaces[0]: unknown keys extra', 'surfaces[0].frame', 'surfaces[0].read', 'surfaces[0].captures', 'surfaces[0].tiles', 'surfaces[1]: must be an object'):
            self.assertIn(fragment, done.stderr)

    def test_error_and_defect_rows_are_checked(self):
        errors = helpers.write_json(
            self.tmp / 'errors.json',
            [{'id': 'PE-1', 'text': 'x', 'status': 'maybe'}, {'id': 'PE-1', 'text': 'y', 'status': 'open'}],
        )
        done = self.render(errors=errors)
        self.assertEqual(done.returncode, 2)
        self.assertIn('errors[0].status', done.stderr)
        defects = helpers.write_json(self.tmp / 'defects.json', [{'id': 'D-1'}, {'id': 'D-1', 'text': 'y', 'note': 'z'}])
        done = self.render(defects=defects)
        self.assertEqual(done.returncode, 2)
        self.assertIn('defects[0].text: is required', done.stderr)
        self.assertIn('defects[1].id: "D-1" repeats defects[0]', done.stderr)
        self.assertIn('defects[1]: unknown keys note', done.stderr)

    def test_a_pipe_in_a_text_does_not_break_the_table(self):
        errors = helpers.write_json(
            self.tmp / 'errors.json', [{'id': 'PE-9', 'text': 'a | b', 'status': 'closed'}]
        )
        self.assertEqual(self.render(errors=errors).returncode, 0)
        self.assertIn('a \\| b', self.report())

    def test_no_check_at_all_is_a_fail(self):
        model = render_report.decide([{'summary': {'checks': 0, 'passed': 0, 'failed': 0}}], [])
        self.assertEqual(model, ('FAIL', ['no acceptance check ran']))

    def test_a_dirty_or_missing_toolset_checkout(self):
        repo = self.tmp / 'toolset'
        commit = make_git_repo(repo)
        self.assertEqual(self.render('--toolset-dir', repo).returncode, 0)
        self.assertIn(f'Toolset commit: `{commit}`', self.report())
        (repo / 'file.txt').write_text('two\n', encoding='utf-8')
        self.assertEqual(self.render('--toolset-dir', repo).returncode, 0)
        self.assertIn(f'Toolset commit: `{commit}-dirty`', self.report())
        done = self.render('--toolset-dir', self.tmp / 'not-a-checkout')
        self.assertEqual(done.returncode, 2)
