from .helpers import TempDirTestCase
from .package_helpers import make_git_repo

from auditlib.toolset import COMMIT, ToolsetError, toolset_commit


class ToolsetCommitTest(TempDirTestCase):
    def test_a_clean_checkout_gives_the_full_hash(self):
        commit = make_git_repo(self.tmp / 'repo')
        self.assertRegex(commit, r'^[0-9a-f]{40}$')
        self.assertEqual(toolset_commit(self.tmp / 'repo'), commit)

    def test_a_subfolder_of_the_checkout_gives_the_same_commit(self):
        commit = make_git_repo(self.tmp / 'repo')
        (self.tmp / 'repo' / 'sub').mkdir()
        self.assertEqual(toolset_commit(self.tmp / 'repo' / 'sub'), commit)

    def test_a_changed_file_adds_dirty(self):
        commit = make_git_repo(self.tmp / 'repo')
        (self.tmp / 'repo' / 'file.txt').write_text('changed\n', encoding='utf-8')
        self.assertEqual(toolset_commit(self.tmp / 'repo'), f'{commit}-dirty')

    def test_a_new_file_adds_dirty(self):
        commit = make_git_repo(self.tmp / 'repo')
        (self.tmp / 'repo' / 'new.txt').write_text('new\n', encoding='utf-8')
        self.assertEqual(toolset_commit(self.tmp / 'repo'), f'{commit}-dirty')

    def test_a_folder_that_is_no_checkout_is_an_error(self):
        (self.tmp / 'plain').mkdir()
        with self.assertRaises(ToolsetError):
            toolset_commit(self.tmp / 'plain')
        with self.assertRaises(ToolsetError):
            toolset_commit(self.tmp / 'nowhere')

    def test_the_commit_pattern(self):
        self.assertTrue(COMMIT.fullmatch('a' * 40))
        self.assertTrue(COMMIT.fullmatch('a' * 40 + '-dirty'))
        self.assertFalse(COMMIT.fullmatch('a' * 39))
        self.assertFalse(COMMIT.fullmatch('A' * 40))
