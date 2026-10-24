"""The names of the design file that a script needs, read from a configuration file.

The scripts hold no name of a design file. The configuration file gives them,
and it stays with the fixtures or in the audit workspace, never in the
repository:

    {
      "spacing_collection": "<the collection of the spacing scale>",
      "theme_collections": ["<a collection whose binding census.py flags>"],
      "context_base": "<a variable name or ID, or #rrggbb>",
      "disabled_variant": {"property": "<a variant property>", "value": "<its disabled value>"}
    }

Each key is optional here; a script stops with an error that names a key it
needs and does not find.
"""

from __future__ import annotations

from dataclasses import dataclass

from .dumps import load_json

KEYS = ('spacing_collection', 'theme_collections', 'context_base', 'disabled_variant')


class ConfigError(Exception):
    """The configuration is missing a key that a script needs, or holds a wrong value."""


@dataclass(frozen=True)
class AuditConfig:
    spacing_collection: str | None = None
    """The variable collection whose default-mode numbers form the spacing scale."""
    theme_collections: tuple[str, ...] = ()
    """The variable collections whose bindings `census.py` counts outside the exemptions."""
    context_base: str | None = None
    """The colour under a text that has no opaque base in its dump: a variable name or ID, or `#rrggbb`."""
    disabled_variant: tuple[str, str] | None = None
    """The variant property and value of a disabled state; its text is exempt from contrast."""

    def require(self, key: str, script: str):
        value = getattr(self, key)
        if value in (None, ()):
            raise ConfigError(f'{script} needs "{key}" in the configuration file. See tools/audit/README.md.')
        return value


def parse_config(data, where: str = 'the configuration') -> AuditConfig:
    """Checks a parsed configuration object."""
    if data is None:
        return AuditConfig()
    if not isinstance(data, dict):
        raise ConfigError(f'{where} must be a JSON object.')
    unknown = sorted(set(data) - set(KEYS))
    if unknown:
        raise ConfigError(f'{where} holds unknown keys: {", ".join(unknown)}. The keys are: {", ".join(KEYS)}.')

    spacing = data.get('spacing_collection')
    if spacing is not None and not (isinstance(spacing, str) and spacing):
        raise ConfigError(f'{where}: "spacing_collection" must be a collection name.')

    themes = data.get('theme_collections', [])
    if not isinstance(themes, list) or not all(isinstance(name, str) and name for name in themes):
        raise ConfigError(f'{where}: "theme_collections" must be a list of collection names.')

    base = data.get('context_base')
    if base is not None and not (isinstance(base, str) and base):
        raise ConfigError(f'{where}: "context_base" must be a variable name, a variable ID, or #rrggbb.')

    disabled = data.get('disabled_variant')
    if disabled is not None:
        if (
            not isinstance(disabled, dict)
            or set(disabled) != {'property', 'value'}
            or not all(isinstance(disabled[k], str) and disabled[k] for k in ('property', 'value'))
        ):
            raise ConfigError(f'{where}: "disabled_variant" must be {{"property": "...", "value": "..."}}.')
        disabled = (disabled['property'], disabled['value'])

    return AuditConfig(
        spacing_collection=spacing,
        theme_collections=tuple(themes),
        context_base=base,
        disabled_variant=disabled,
    )


def load_config(path) -> AuditConfig:
    """Reads a configuration file. No path gives an empty configuration."""
    if path is None:
        return AuditConfig()
    return parse_config(load_json(path), str(path))
