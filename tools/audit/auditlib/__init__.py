"""Shared input and output code of the audit scripts.

- `dumps`: the loaders of the baseline format and of the `dump_nodes` output.
- `manifest`: the SHA-256 check of each evidence file against its manifest.
- `outputs`: the guard that keeps each write inside the outputs folder.
"""
